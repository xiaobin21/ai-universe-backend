'use strict';

/**
 * Anthropic (Claude) 供应商适配器（契约 §2 / §2.1，[HARD]）。
 *
 * 协议硬约束：
 *  - 鉴权：x-api-key + anthropic-version: 2023-06-01
 *  - 端点：{base}/v1/messages
 *  - system 必须为 body 顶层字段，禁止塞进 messages
 *  - 工具为 tool_use / tool_result content block（不是 OpenAI tool_calls 数组）
 *  - 流式事件：message_start(input_tokens) / content_block_delta
 *    (text_delta→正文；thinking_delta→思考链) / message_delta(output_tokens) / message_stop
 *  - 图片：source.type=base64 + media_type + data
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

class AnthropicAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'anthropic';
  }

  /** 能力兜底声明（DB model_capabilities 可覆盖） */
  capabilitiesFor(providerModel) {
    const m = providerModel || '';
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
      supportsSystemPrompt: true,
      // Claude 4 系（Opus/Sonnet）支持 extended thinking；Haiku 3.5 不支持
      supportsThinking: /opus|sonnet/i.test(m),
      supportsStructuredOutput: false,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      imageInputFormats: ['base64'],
      toolCallFormat: 'anthropic',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    };
  }

  /**
   * 列模型（契约 §2）：Anthropic 无公开列模型接口，恒不支持。
   * 保留种子目录，发现阶段跳过。
   */
  async listModels() {
    return { supported: false, reason: 'unsupported' };
  }

  /** 内部 ChatRequest -> { url, headers, body } */
  buildRequest(req) {
    const apiKey = req.apiKey || (req.credentials && req.credentials.apiKey);
    if (!apiKey) throw new AppError('nokey', '未配置 Anthropic API Key');
    const baseUrl = (req.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const providerModel = req.model && req.model.providerModel;
    if (!providerModel) throw new AppError('badreq', '缺少 providerModel');

    // ① system 全部汇总到顶层字段，绝不进入 messages
    let systemText = '';
    const messages = [];
    for (const msg of req.messages || []) {
      if (msg.role === 'system') {
        const t = this._systemText(msg.parts);
        if (t) systemText = systemText ? systemText + '\n' + t : t;
        continue;
      }
      const content = this._partsToBlocks(msg.parts);
      if (content.length) {
        messages.push({ role: this._toAnthropicRole(msg.role), content });
      }
    }

    const body = {
      model: providerModel,
      max_tokens: req.maxOutputTokens || 4096,
      messages,
      stream: true,
    };
    if (systemText) body.system = systemText;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (Array.isArray(req.tools) && req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
      }));
    }

    return {
      url: baseUrl + '/v1/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body,
    };
  }

  _toAnthropicRole(role) {
    // 'tool' 角色结果在 Anthropic 里放进 user 轮的 tool_result block
    if (role === 'tool') return 'user';
    return role === 'assistant' ? 'assistant' : 'user';
  }

  _systemText(parts) {
    return (parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
  }

  _extractImage(part) {
    if (part.dataBase64) return { mediaType: part.mediaType || 'image/jpeg', data: part.dataBase64 };
    if (part.url && part.url.startsWith('data:')) {
      const m = part.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { mediaType: m[1], data: m[2] };
    }
    return { mediaType: part.mediaType || 'image/jpeg', data: '' };
  }

  /** 多部分 ChatPart -> Anthropic content block 数组 */
  _partsToBlocks(parts) {
    const blocks = [];
    for (const p of parts || []) {
      if (!p) continue;
      switch (p.type) {
        case 'text':
          if (p.text) blocks.push({ type: 'text', text: p.text });
          break;
        case 'reasoning':
          // 历史思考不外发（重放 thinking block 需要 signature，流式仅拿到文本，无法忠实重建）
          break;
        case 'tool_call':
          blocks.push({ type: 'tool_use', id: p.toolCallId, name: p.name, input: p.args || {} });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? ''),
            ...(p.isError ? { is_error: true } : {}),
          });
          break;
        case 'image': {
          const { mediaType, data } = this._extractImage(p);
          if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
          break;
        }
        case 'attachment':
          if (p.text) blocks.push({ type: 'text', text: p.text });
          break;
        case 'refusal':
          blocks.push({ type: 'text', text: `[模型拒绝回答] ${p.text || ''}` });
          break;
        default:
          break;
      }
    }
    return blocks;
  }

  /** 解析 SSE 流 -> async generator yield 统一 ChatChunk */
  async *parseStream(response, ctx) {
    const body = response && response.body;
    if (!body) throw new AppError('upstream', 'Anthropic 响应缺少 body');

    const out = [];
    const state = {
      lastEvent: '',
      promptTokens: 0,
      completionTokens: 0,
      errorSeen: false,
      toolIdByIndex: {},
    };

    const onLine = (line) => this._handleLine(line, state, out);

    try {
      await pumpSSE(body, { signal: ctx && ctx.signal, onLine });
    } catch (e) {
      if (!state.errorSeen) {
        out.push({
          kind: 'error',
          error: e && e.code
            ? e
            : new AppError('network', `Anthropic 流中断: ${(e && e.message) || e}`, { cause: e }),
        });
      }
    }

    for (const c of out) {
      yield c;
      if (c.kind === 'error') return;
    }
  }

  _maybeYieldUsage(state, out) {
    if (state.promptTokens > 0 && state.completionTokens > 0) {
      out.push({
        kind: 'usage',
        usage: {
          promptTokens: state.promptTokens,
          completionTokens: state.completionTokens,
          totalTokens: state.promptTokens + state.completionTokens,
          usageSource: 'upstream',
        },
      });
    }
  }

  _handleLine(line, state, out) {
    if (state.errorSeen) return;
    if (line.startsWith('event:')) {
      state.lastEvent = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;

    let j;
    try {
      j = JSON.parse(line.slice(5).replace(/^ /, ''));
    } catch {
      return;
    }
    if (!j) return;

    // 协议级错误事件（event: error 或 data 内自带 error）
    if (state.lastEvent === 'error' || j.type === 'error' || (j.error && state.lastEvent !== 'message_start')) {
      out.push({ kind: 'error', error: this._upstreamError(j) });
      state.errorSeen = true;
      return;
    }

    if (state.lastEvent === 'message_start' && j.message && j.message.usage) {
      state.promptTokens = j.message.usage.input_tokens || 0;
      this._maybeYieldUsage(state, out);
    }

    if (state.lastEvent === 'message_delta' && j.usage) {
      state.completionTokens = j.usage.output_tokens || state.completionTokens;
      this._maybeYieldUsage(state, out);
    }

    if (state.lastEvent === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
      state.toolIdByIndex[j.index] = j.content_block.id;
      out.push({ kind: 'toolCallDelta', toolCallId: j.content_block.id, name: j.content_block.name });
    }

    if (state.lastEvent === 'content_block_delta' && j.delta) {
      const d = j.delta;
      if (d.type === 'text_delta' && d.text) {
        out.push({ kind: 'textDelta', text: d.text });
      } else if (d.type === 'thinking_delta' && d.thinking) {
        // 思考链独立 reasoningDelta part，禁止拼正文
        out.push({ kind: 'reasoningDelta', text: d.thinking });
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const toolCallId = state.toolIdByIndex[j.index];
        if (toolCallId) out.push({ kind: 'toolCallDelta', toolCallId, argsDelta: d.partial_json });
      }
    }

    if (state.lastEvent === 'message_stop') {
      out.push({ kind: 'done' });
    }
  }

  _upstreamError(j) {
    const e = (j && j.error) || {};
    const msg = e.message || 'Anthropic 流错误';
    if (e.type === 'overloaded_error') {
      return new AppError('upstream', `Anthropic 过载: ${msg}`, { retryable: true });
    }
    if (e.type === 'rate_limit_error') {
      return new AppError('rate', `Anthropic 限流: ${msg}`, { retryable: true });
    }
    if (e.type === 'authentication_error' || e.type === 'permission_error') {
      return new AppError('auth', `Anthropic 鉴权失败: ${msg}`);
    }
    if (e.type === 'invalid_request_error') {
      return new AppError('badreq', `Anthropic 请求错误: ${msg}`);
    }
    return new AppError('upstream', `Anthropic 流错误: ${msg}`, { retryable: false });
  }

  /** 非 2xx / 网络错误 -> AppError */
  mapError(status, rawText, cause) {
    let msg = `Anthropic 上游错误 ${status}`;
    let type = '';
    try {
      const j = JSON.parse(rawText || '');
      if (j && j.error) {
        msg = j.error.message || msg;
        type = j.error.type || '';
      }
    } catch { /* 非 JSON 错误体，保留默认 */ }

    if (status === 401 || status === 403 || type === 'authentication_error') {
      return new AppError('auth', `Anthropic 鉴权失败: ${msg}`, { cause });
    }
    if (status === 429 || type === 'rate_limit_error') {
      return new AppError('rate', `Anthropic 限流: ${msg}`, { retryable: true, cause });
    }
    if (type === 'overloaded_error' || status === 529) {
      return new AppError('upstream', `Anthropic 过载: ${msg}`, { retryable: true, cause });
    }
    if (status === 400 || status === 404) {
      return new AppError('badreq', `Anthropic 请求错误: ${msg}`, { cause });
    }
    if (status >= 500) {
      return new AppError('upstream', `Anthropic 上游错误: ${msg}`, { retryable: true, cause });
    }
    return new AppError('upstream', msg, { cause });
  }

  /** 非流式最终载荷 -> Usage；无则 null（由核心估算） */
  extractUsage(payload) {
    if (!payload || !payload.usage) return null;
    const u = payload.usage;
    const promptTokens = u.input_tokens || 0;
    const completionTokens = u.output_tokens || 0;
    if (!promptTokens && !completionTokens) return null;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      usageSource: 'upstream',
    };
  }
}

module.exports = { AnthropicAdapter };
