'use strict';

/**
 * 供应商适配器：OpenAI（契约 §2 / §2.1 表第 1 行）。
 *  - 鉴权：Authorization: Bearer <apiKey>
 *  - 端点：<base>/chat/completions（base 默认 https://api.openai.com/v1）
 *  - system 走 messages role=system
 *  - 流式：SSE data: 行 + [DONE]；请求体带 stream_options:{include_usage:true}
 *  - 思考链：delta.reasoning_content -> reasoningDelta（独立 part，禁止拼正文）
 *  - 用量：j.usage.prompt_tokens / completion_tokens；识别 prompt_tokens_details.cached_tokens、
 *          o 系 completion_tokens_details.reasoning_tokens
 *
 * 注意：即使 OpenAI 兼容，错误码/限流/用量字段也在本文件单独解析，不假设全功能一致。
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

/**
 * 已知 OpenAI 模型的兜底能力声明（权威在 DB model_capabilities；此处仅默认/兜底）。
 * 数据来自集成契约 §6 模型目录。
 */
const KNOWN_MODELS = {
  'gpt-4o':        { contextWindow: 128000,  maxOutputTokens: 16384, vision: true,  tools: true, struct: true,  thinking: false },
  'gpt-4o-mini':   { contextWindow: 128000,  maxOutputTokens: 16384, vision: true,  tools: true, struct: true,  thinking: false },
  'gpt-4.1':       { contextWindow: 1047576, maxOutputTokens: 32768, vision: false, tools: true, struct: true,  thinking: false },
  'o3-mini':       { contextWindow: 200000,  maxOutputTokens: 65536, vision: false, tools: true, struct: true,  thinking: true  },
};
const FALLBACK = { contextWindow: 128000, maxOutputTokens: 4096, vision: false, tools: true, struct: true, thinking: false };

class OpenAIAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'openai';
    this.defaultBase = 'https://api.openai.com/v1';
  }

  /**
   * 能力声明（兜底）。DB model_capabilities 可覆盖。
   * @param {string} providerModel
   */
  capabilitiesFor(providerModel) {
    const k = KNOWN_MODELS[providerModel] || FALLBACK;
    return {
      supportsStreaming: true,
      supportsTools: k.tools,
      supportsVision: k.vision,
      supportsSystemPrompt: true,
      supportsThinking: k.thinking,
      supportsStructuredOutput: k.struct,
      contextWindow: k.contextWindow,
      maxOutputTokens: k.maxOutputTokens,
      imageInputFormats: k.vision ? ['url'] : [],
      toolCallFormat: 'openai',
      inputModalities: k.vision ? ['text', 'image'] : ['text'],
      outputModalities: ['text'],
    };
  }

  /**
   * 列模型（契约 §2）：GET {base}/models（Bearer），解析 data[].id。
   * 404/405/401/网络错误一律优雅降级为 {supported:false}，不抛错。
   */
  async listModels(opts = {}) {
    return this._openAIListModels({ ...opts, defaultBase: this.defaultBase });
  }

  /**
   * 内部 ChatRequest -> { url, headers, body }。
   * 约定：聊天核心在调用前已把解密后的凭证注入 req.apiKey，
   * 并按需注入 req.baseUrl（用户自定义 Base URL 覆盖默认值）。
   */
  buildRequest(req) {
    const base = (req.baseUrl || this.defaultBase).replace(/\/+$/, '');
    if (!req.apiKey) {
      throw new AppError('nokey', '尚未配置 OpenAI 密钥');
    }
    const body = {
      model: req.model.providerModel,
      messages: this._convertMessages(req.messages || []),
      stream: true,
      max_tokens: req.maxOutputTokens,
      stream_options: { include_usage: true },
    };
    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
      body.temperature = req.temperature;
    }
    if (Array.isArray(req.tools) && req.tools.length) {
      body.tools = req.tools;
    }
    return {
      url: base + '/chat/completions',
      headers: {
        Authorization: 'Bearer ' + req.apiKey,
        'Content-Type': 'application/json',
      },
      body,
    };
  }

  /**
   * 把统一多部分 ChatMessage[] 转成 OpenAI messages 数组。
   *  - system -> role:system（文本拼接）
   *  - user 含图 -> content 数组（text + image_url，dataURL 走 url 字段）
   *  - assistant -> content 文本 + tool_calls（思考链 reasoning 不回传）
   *  - tool -> role:tool（每个 tool_result 一条）
   */
  _convertMessages(messages) {
    const out = [];
    for (const msg of messages) {
      const parts = msg.parts || [];
      if (msg.role === 'system') {
        const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        out.push({ role: 'system', content: text });
        continue;
      }
      if (msg.role === 'tool') {
        for (const p of parts) {
          if (p.type !== 'tool_result') continue;
          out.push({
            role: 'tool',
            tool_call_id: p.toolCallId,
            content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? ''),
          });
        }
        continue;
      }
      if (msg.role === 'user') {
        const text = parts.filter((p) => p.type === 'text' || p.type === 'refusal').map((p) => p.text).join('');
        const images = parts.filter((p) => p.type === 'image');
        if (images.length) {
          const content = [];
          if (text) content.push({ type: 'text', text });
          for (const img of images) {
            const url = img.url || `data:${img.mediaType || 'image/jpeg'};base64,${img.dataBase64 || ''}`;
            content.push({ type: 'image_url', image_url: { url } });
          }
          out.push({ role: 'user', content });
        } else {
          out.push({ role: 'user', content: text });
        }
        continue;
      }
      // assistant
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      const toolCalls = parts
        .filter((p) => p.type === 'tool_call')
        .map((p) => ({
          id: p.toolCallId,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.args || {}) },
        }));
      const m = { role: 'assistant' };
      m.content = toolCalls.length ? (text || null) : text;
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    }
    return out;
  }

  /**
   * 解析上游 SSE 流 -> async generator yield 统一 ChatChunk。
   * 用 pumpSSE 读行，桥接 push（回调）-> pull（生成器）以保留真流式。
   */
  async *parseStream(response, ctx = {}) {
    const stream = response && response.body;
    const signal = ctx.signal;
    if (!stream) {
      yield { kind: 'done' };
      return;
    }

    const state = { doneSeen: false };
    const queue = [];
    let waiters = [];
    let doneFlag = false;
    let failure = null;
    const wake = () => {
      const w = waiters; waiters = [];
      for (const r of w) r();
    };

    pumpSSE(stream, {
      signal,
      onLine: (line) => {
        for (const chunk of this._parseDataLine(line, state)) queue.push(chunk);
        wake();
      },
    }).then(
      () => { doneFlag = true; wake(); },
      (e) => { failure = e; wake(); }
    );

    for (;;) {
      while (queue.length) yield queue.shift();
      if (failure) throw failure;
      if (doneFlag) break;
      await new Promise((resolve) => waiters.push(resolve));
    }
    yield { kind: 'done' };
  }

  /**
   * 单行 SSE -> ChatChunk[]。非 data: 行 / 空 chunk / 坏 JSON 一律安全跳过。
   */
  _parseDataLine(line, state) {
    const out = [];
    if (!line || state.doneSeen) return out;
    if (!line.startsWith('data:')) return out;
    const data = line.slice(5).replace(/^ /, '').trim();
    if (!data) return out; // 空 chunk
    if (data === '[DONE]') { state.doneSeen = true; return out; }

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return out; // 坏 JSON 跳过
    }
    if (!j || typeof j !== 'object') return out;

    // 上游在流中下发错误对象（罕见）
    if (j.error) {
      throw this._errorFromUpstreamPayload(j.error);
    }

    if (j.usage) {
      const u = this.extractUsage(j);
      if (u) out.push({ kind: 'usage', usage: u });
    }

    const choice = j.choices && j.choices[0];
    const delta = choice && choice.delta;
    if (!delta) return out;

    if (delta.reasoning_content) {
      out.push({ kind: 'reasoningDelta', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content.length) {
      out.push({ kind: 'textDelta', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        out.push({
          kind: 'toolCallDelta',
          toolCallId: tc.id,
          name: tc.function && tc.function.name,
          argsDelta: tc.function && tc.function.arguments,
        });
      }
    }
    return out;
  }

  /** 非 2xx / 网络错误 -> AppError（契约 §7） */
  mapError(status, rawText, cause) {
    let message;
    let upstreamCode;
    try {
      const j = JSON.parse(rawText);
      if (j && j.error) {
        message = j.error.message;
        upstreamCode = j.error.code;
      }
    } catch {
      /* 非 JSON 错误体 */
    }
    return this._mapErrorInfo(status, message, upstreamCode, cause);
  }

  /** 流中错误对象（无 HTTP status）-> AppError */
  _errorFromUpstreamPayload(errObj) {
    const message = (errObj && errObj.message) || '上游流式错误';
    const upstreamCode = errObj && errObj.code;
    const upstreamType = errObj && errObj.type;
    // 流中错误没有 HTTP 状态，按错误码/类型粗判；默认 upstream（可重试）
    if (upstreamType === 'invalid_request_error' || upstreamCode === 'invalid_request_error' || upstreamCode === 'invalid_request') {
      return new AppError('badreq', message);
    }
    if (upstreamCode === 'rate_limit_exceeded') {
      return new AppError('rate', message, { retryable: true });
    }
    return new AppError('upstream', message, { retryable: true });
  }

  _mapErrorInfo(status, message, upstreamCode, cause) {
    if (status === 401 || status === 403) {
      return new AppError('auth', message || `上游鉴权失败 (${status})`, { cause });
    }
    if (status === 429) {
      return new AppError('rate', message || '上游限流', { retryable: true, cause });
    }
    if (status === 404) {
      return new AppError('notfound', message || '模型不存在或无访问权限', { cause });
    }
    if (status === 402 || upstreamCode === 'insufficient_quota') {
      return new AppError('budget', message || '账户额度不足', { cause });
    }
    if (status === 400) {
      return new AppError('badreq', message || '请求参数错误', { cause });
    }
    if (status >= 500) {
      return new AppError('upstream', message || `上游错误 ${status}`, { retryable: true, cause });
    }
    return new AppError('upstream', message || `上游错误 ${status}`, { cause });
  }

  /**
   * 从上游最终载荷提取 Usage；无则 null（由核心估算）。
   * 支持直接传 usage 对象或传整段 chunk（含 .usage）。
   */
  extractUsage(payload) {
    const u = payload && (payload.usage || payload);
    if (!u || (u.prompt_tokens == null && u.completion_tokens == null && u.total_tokens == null)) {
      return null;
    }
    const promptTokens = Number(u.prompt_tokens) || 0;
    const completionTokens = Number(u.completion_tokens) || 0;
    const totalTokens = Number(u.total_tokens) || promptTokens + completionTokens;
    const usage = { promptTokens, completionTokens, totalTokens, usageSource: 'upstream' };

    // 命中缓存的输入 token（计费可优惠；附带供计费层识别）
    const pd = u.prompt_tokens_details;
    if (pd && typeof pd.cached_tokens === 'number') {
      usage.cachedTokens = pd.cached_tokens;
    }
    // o 系推理 token
    const cd = u.completion_tokens_details;
    if (cd && typeof cd.reasoning_tokens === 'number') {
      usage.reasoningTokens = cd.reasoning_tokens;
    }
    return usage;
  }
}

module.exports = { OpenAIAdapter };
