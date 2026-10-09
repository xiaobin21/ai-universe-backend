'use strict';

/**
 * Gemini (Google Generative Language) 供应商适配器（契约 §2 / §2.1，[HARD]）。
 *
 * 协议硬约束：
 *  - 鉴权：?key=<apiKey>（query 内；也支持 x-goog-api-key，这里按前端参考用 query）
 *  - 端点：{base}/v1beta/models/{model}:streamGenerateContent?alt=sse
 *  - system 走 systemInstruction.parts，不是 messages role=system
 *  - 工具是 functionCall / functionResponse part（不是 OpenAI tool_calls 数组）
 *  - usageMetadata.promptTokenCount / candidatesTokenCount
 *  - part.text -> 正文；part.thought=true 时 part.text -> 思考链 reasoningDelta
 *  - 图片：inline_data { mime_type, data(base64) }
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

class GeminiAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'gemini';
  }

  /** 能力兜底声明（DB model_capabilities 可覆盖） */
  capabilitiesFor(providerModel) {
    const m = providerModel || '';
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
      supportsSystemPrompt: true,
      // Gemini 2.5 Pro / 2.0 Flash 等支持 thinking
      supportsThinking: /2\.5|2\.0|pro|think/i.test(m),
      supportsStructuredOutput: true,
      contextWindow: 1048576,
      maxOutputTokens: 8192,
      imageInputFormats: ['base64'],
      toolCallFormat: 'gemini',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    };
  }

  /** 内部 ChatRequest -> { url, headers, body } */
  buildRequest(req) {
    const apiKey = req.apiKey || (req.credentials && req.credentials.apiKey);
    if (!apiKey) throw new AppError('nokey', '未配置 Gemini API Key');
    const baseUrl = (req.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const providerModel = req.model && req.model.providerModel;
    if (!providerModel) throw new AppError('badreq', '缺少 providerModel');

    // ① system 全部汇总到顶层 systemInstruction.parts
    let systemText = '';
    const contents = [];
    for (const msg of req.messages || []) {
      if (msg.role === 'system') {
        const t = (msg.parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
        if (t) systemText = systemText ? systemText + '\n' + t : t;
        continue;
      }
      const role = msg.role === 'assistant' ? 'model' : (msg.role === 'tool' ? 'function' : 'user');
      const parts = this._partsToGeminiParts(msg.parts);
      if (parts.length) contents.push({ role, parts });
    }

    const body = { contents, generationConfig: { maxOutputTokens: req.maxOutputTokens || 4096 } };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    if (typeof req.temperature === 'number') body.generationConfig.temperature = req.temperature;
    if (Array.isArray(req.tools) && req.tools.length) {
      body.tools = [{
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || t.inputSchema || { type: 'object', properties: {} },
        })),
      }];
    }

    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(providerModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    return {
      url,
      headers: { 'content-type': 'application/json' },
      body,
    };
  }

  _extractImage(part) {
    if (part.dataBase64) return { mime_type: part.mediaType || 'image/jpeg', data: part.dataBase64 };
    if (part.url && part.url.startsWith('data:')) {
      const m = part.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { mime_type: m[1], data: m[2] };
    }
    return { mime_type: part.mediaType || 'image/jpeg', data: '' };
  }

  /** 多部分 ChatPart -> Gemini part 数组 */
  _partsToGeminiParts(parts) {
    const out = [];
    for (const p of parts || []) {
      if (!p) continue;
      switch (p.type) {
        case 'text':
          if (p.text) out.push({ text: p.text });
          break;
        case 'reasoning':
          // 历史思考不外发（Gemini 历史 model 轮不含 thought part）
          break;
        case 'tool_call':
          out.push({ functionCall: { name: p.name, args: p.args || {} } });
          break;
        case 'tool_result':
          // Gemini functionResponse 需要 name 与 functionCall 对应；
          // ChatPart.tool_result 仅带 toolCallId，best-effort 用 toolCallId 占位
          out.push({
            functionResponse: {
              name: p.toolCallId || 'tool',
              response: { result: typeof p.content === 'string' ? p.content : p.content ?? '' },
            },
          });
          break;
        case 'image': {
          const { mime_type, data } = this._extractImage(p);
          if (data) out.push({ inline_data: { mime_type, data } });
          break;
        }
        case 'attachment':
          if (p.text) out.push({ text: p.text });
          break;
        case 'refusal':
          out.push({ text: `[模型拒绝回答] ${p.text || ''}` });
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** 解析 SSE 流 -> async generator yield 统一 ChatChunk */
  async *parseStream(response, ctx) {
    const body = response && response.body;
    if (!body) throw new AppError('upstream', 'Gemini 响应缺少 body');

    const out = [];
    const state = { promptTokens: 0, completionTokens: 0, errorSeen: false, callIndex: 0 };

    const onLine = (line) => this._handleLine(line, state, out);

    try {
      await pumpSSE(body, { signal: ctx && ctx.signal, onLine });
    } catch (e) {
      if (!state.errorSeen) {
        out.push({
          kind: 'error',
          error: e && e.code
            ? e
            : new AppError('network', `Gemini 流中断: ${(e && e.message) || e}`, { cause: e }),
        });
      }
    }

    // Gemini 无显式结束事件，正常读完即 done
    if (!state.errorSeen) out.push({ kind: 'done' });

    for (const c of out) {
      yield c;
      if (c.kind === 'error') return;
    }
  }

  _handleLine(line, state, out) {
    if (state.errorSeen) return;
    if (!line.startsWith('data:')) return;

    let j;
    try {
      j = JSON.parse(line.slice(5).replace(/^ /, ''));
    } catch {
      return;
    }
    if (!j) return;

    // 协议级错误：顶层 error 对象
    if (j.error) {
      out.push({ kind: 'error', error: this._geminiError(j.error) });
      state.errorSeen = true;
      return;
    }

    if (j.usageMetadata) {
      const um = j.usageMetadata;
      state.promptTokens = um.promptTokenCount || state.promptTokens;
      state.completionTokens = um.candidatesTokenCount || state.completionTokens;
      if (state.promptTokens || state.completionTokens) {
        out.push({
          kind: 'usage',
          usage: {
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
            totalTokens: um.totalTokenCount || state.promptTokens + state.completionTokens,
            usageSource: 'upstream',
          },
        });
      }
    }

    const cand = j.candidates && j.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (parts) {
      for (const pt of parts) {
        if (!pt) continue;
        if (pt.functionCall) {
          state.callIndex += 1;
          out.push({
            kind: 'toolCallDelta',
            toolCallId: `call_${state.callIndex}`,
            name: pt.functionCall.name,
            argsDelta: JSON.stringify(pt.functionCall.args || {}),
          });
        } else if (pt.thought) {
          // thought part 的文本即思考链，独立 reasoningDelta
          if (pt.text) out.push({ kind: 'reasoningDelta', text: pt.text });
        } else if (typeof pt.text === 'string' && pt.text) {
          out.push({ kind: 'textDelta', text: pt.text });
        }
      }
    }
  }

  _geminiError(err) {
    const msg = (err && err.message) || 'Gemini 流错误';
    const code = (err && err.code) || 0;
    const status = (err && err.status) || '';
    if (status === 'PERMISSION_DENIED' || code === 401 || code === 403) {
      return new AppError('auth', `Gemini 鉴权失败: ${msg}`);
    }
    if (status === 'RESOURCE_EXHAUSTED' || code === 429) {
      return new AppError('rate', `Gemini 限流: ${msg}`, { retryable: true });
    }
    if (code === 400 || status === 'INVALID_ARGUMENT') {
      return new AppError('badreq', `Gemini 请求错误: ${msg}`);
    }
    if (code === 404) {
      return new AppError('notfound', `Gemini 模型不存在: ${msg}`);
    }
    if (code >= 500 || status === 'UNAVAILABLE' || status === 'INTERNAL') {
      return new AppError('upstream', `Gemini 上游错误: ${msg}`, { retryable: true });
    }
    return new AppError('upstream', `Gemini 流错误: ${msg}`, { retryable: false });
  }

  /** 非 2xx / 网络错误 -> AppError */
  mapError(status, rawText, cause) {
    let msg = `Gemini 上游错误 ${status}`;
    let errObj = null;
    try {
      const j = JSON.parse(rawText || '');
      if (j && j.error) errObj = j.error;
    } catch { /* 非 JSON */ }

    if (status === 401 || status === 403) {
      return new AppError('auth', `Gemini 鉴权失败: ${errObj && errObj.message || msg}`, { cause });
    }
    if (status === 429) {
      return new AppError('rate', `Gemini 限流: ${errObj && errObj.message || msg}`, { retryable: true, cause });
    }
    if (status === 400) {
      return new AppError('badreq', `Gemini 请求错误: ${errObj && errObj.message || msg}`, { cause });
    }
    if (status === 404) {
      return new AppError('notfound', `Gemini 模型不存在: ${errObj && errObj.message || msg}`, { cause });
    }
    if (status >= 500) {
      return new AppError('upstream', `Gemini 上游错误: ${errObj && errObj.message || msg}`, { retryable: true, cause });
    }
    return new AppError('upstream', errObj && errObj.message || msg, { cause });
  }

  /** 非流式最终载荷 -> Usage；无则 null（由核心估算） */
  extractUsage(payload) {
    const um = payload && payload.usageMetadata;
    if (!um) return null;
    const promptTokens = um.promptTokenCount || 0;
    const completionTokens = um.candidatesTokenCount || 0;
    if (!promptTokens && !completionTokens) return null;
    return {
      promptTokens,
      completionTokens,
      totalTokens: um.totalTokenCount || promptTokens + completionTokens,
      usageSource: 'upstream',
    };
  }
}

module.exports = { GeminiAdapter };
