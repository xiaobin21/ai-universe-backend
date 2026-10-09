'use strict';

/**
 * 供应商适配器：DeepSeek（契约 §2 / §2.1 表第 4 行）。
 * OpenAI 兼容协议，但能力与字段按 providerModel 区分：
 *  - deepseek-chat（V3）：无思考链，支持 tools / structured output
 *  - deepseek-reasoner（R1）：有思考链，delta 带 reasoning_content；不支持 structured output
 *  - base 默认 https://api.deepseek.com/v1；端点 /chat/completions；Bearer 鉴权
 * 即使 OpenAI 兼容，错误码 / 限流 / 用量字段仍在本文件单独解析。
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

const KNOWN_MODELS = {
  // 数据来自集成契约 §6 模型目录
  'deepseek-chat':     { contextWindow: 65536, maxOutputTokens: 8192, thinking: false, tools: true, struct: true },
  'deepseek-reasoner': { contextWindow: 65536, maxOutputTokens: 8192, thinking: true,  tools: true, struct: false },
};
const FALLBACK = { contextWindow: 65536, maxOutputTokens: 4096, thinking: false, tools: true, struct: true };

class DeepseekAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'deepseek';
    this.defaultBase = 'https://api.deepseek.com/v1';
  }

  /** 能力按 providerModel 区分：reasoner 有思考链、无 structured；chat 相反。 */
  capabilitiesFor(providerModel) {
    const k = KNOWN_MODELS[providerModel] || FALLBACK;
    return {
      supportsStreaming: true,
      supportsTools: k.tools,
      supportsVision: false,
      supportsSystemPrompt: true,
      supportsThinking: k.thinking,
      supportsStructuredOutput: k.struct,
      contextWindow: k.contextWindow,
      maxOutputTokens: k.maxOutputTokens,
      imageInputFormats: [],
      toolCallFormat: 'openai',
      inputModalities: ['text'],
      outputModalities: ['text'],
    };
  }

  /**
   * 内部 ChatRequest -> { url, headers, body }。
   * 约定：聊天核心已注入 req.apiKey；可选 req.baseUrl 覆盖默认。
   */
  buildRequest(req) {
    const base = (req.baseUrl || this.defaultBase).replace(/\/+$/, '');
    if (!req.apiKey) {
      throw new AppError('nokey', '尚未配置 DeepSeek 密钥');
    }
    const body = {
      model: req.model.providerModel,
      messages: this._convertMessages(req.messages || []),
      stream: true,
      max_tokens: req.maxOutputTokens,
      stream_options: { include_usage: true },
    };
    // deepseek-reasoner 不支持 temperature 等采样参数；仅 chat 模型透传
    if (
      typeof req.temperature === 'number' &&
      Number.isFinite(req.temperature) &&
      req.model.providerModel !== 'deepseek-reasoner'
    ) {
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

  /** 统一多部分 -> OpenAI 风格 messages（与 openai 适配器同构，但独立实现）。 */
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
        out.push({ role: 'user', content: text });
        continue;
      }
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
   * 解析 SSE 流 -> ChatChunk。reasoner 的 reasoning_content 独立 yield reasoningDelta。
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

  _parseDataLine(line, state) {
    const out = [];
    if (!line || state.doneSeen) return out;
    if (!line.startsWith('data:')) return out;
    const data = line.slice(5).replace(/^ /, '').trim();
    if (!data) return out;
    if (data === '[DONE]') { state.doneSeen = true; return out; }

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return out;
    }
    if (!j || typeof j !== 'object') return out;

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

    // reasoner 思考链
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

  mapError(status, rawText, cause) {
    let message;
    let upstreamCode;
    try {
      const j = JSON.parse(rawText);
      if (j && j.error) {
        message = j.error.message;
        upstreamCode = j.error.code;
      }
    } catch { /* 非 JSON */ }
    return this._mapErrorInfo(status, message, upstreamCode, cause);
  }

  _errorFromUpstreamPayload(errObj) {
    const message = (errObj && errObj.message) || 'DeepSeek 流式错误';
    const upstreamCode = errObj && errObj.code;
    const upstreamType = errObj && errObj.type;
    if (upstreamType === 'invalid_request_error' || upstreamCode === 'invalid_request_error' || upstreamCode === 'invalid_request') {
      return new AppError('badreq', message);
    }
    if (upstreamCode === 'rate_limit_exceeded' || upstreamCode === 'server_error') {
      return new AppError('rate', message, { retryable: true });
    }
    return new AppError('upstream', message, { retryable: true });
  }

  _mapErrorInfo(status, message, upstreamCode, cause) {
    if (status === 401 || status === 403) {
      return new AppError('auth', message || `DeepSeek 鉴权失败 (${status})`, { cause });
    }
    if (status === 429) {
      return new AppError('rate', message || 'DeepSeek 限流', { retryable: true, cause });
    }
    if (status === 404) {
      return new AppError('notfound', message || '模型不存在', { cause });
    }
    if (status === 402 || upstreamCode === 'insufficient_quota') {
      return new AppError('budget', message || '账户余额不足', { cause });
    }
    if (status === 400) {
      return new AppError('badreq', message || '请求参数错误（注意 deepseek-reasoner 不支持 temperature）', { cause });
    }
    if (status >= 500) {
      return new AppError('upstream', message || `DeepSeek 上游错误 ${status}`, { retryable: true, cause });
    }
    return new AppError('upstream', message || `DeepSeek 上游错误 ${status}`, { cause });
  }

  /**
   * 提取 Usage；识别 DeepSeek 的 prompt_cache_hit_tokens / prompt_cache_miss_tokens。
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

    if (typeof u.prompt_cache_hit_tokens === 'number') {
      usage.cachedTokens = u.prompt_cache_hit_tokens;
    }
    if (typeof u.prompt_cache_miss_tokens === 'number') {
      usage.cacheMissTokens = u.prompt_cache_miss_tokens;
    }
    return usage;
  }
}

module.exports = { DeepseekAdapter };
