'use strict';

/**
 * 豆包（火山方舟 Ark）适配器 —— OpenAI 兼容协议。
 * 契约 §2.1：doubao | Bearer | /api/v3/chat/completions | OpenAI messages | OpenAI SSE | 部分模型 reasoning 字段
 *
 * 注意：
 *  - 豆包 Ark 兼容 OpenAI /chat/completions，但部分模型在 delta 中回传 `reasoning`（非 `reasoning_content`）。
 *  - 本适配器同时兼容两种字段名，命中其一即产出 reasoningDelta。
 *  - 出站 URL 由传输层 safeFetch 过 SSRF；本类只产出 url，不直接发请求。
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

class DoubaoAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'doubao';
  }

  /**
   * 能力声明（兜底；DB model_capabilities 可覆盖）。
   * 契约 §6：doubao-pro/lite ctx=32768, out=4096, flags=tools,struct
   */
  capabilitiesFor(providerModel) {
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
      supportsSystemPrompt: true,
      supportsThinking: false,
      supportsStructuredOutput: true,
      contextWindow: 32768,
      maxOutputTokens: 4096,
      imageInputFormats: [],
      toolCallFormat: 'openai',
      inputModalities: ['text'],
      outputModalities: ['text'],
    };
  }

  /** 列模型（契约 §2）：GET {base}/models，解析 data[].id。 */
  async listModels(opts = {}) {
    return this._openAIListModels({ ...opts, defaultBase: DEFAULT_BASE_URL });
  }

  /**
   * ChatRequest -> { url, headers, body }
   * req.apiKey: 用户解密后的豆包 API Key（核心注入）
   * req.baseUrl?: 自定义 base URL（用户在凭证页填写，默认 Ark 官方）
   */
  buildRequest(req) {
    const apiKey = req.apiKey;
    if (!apiKey) throw new AppError('nokey', '豆包 API Key 未配置');

    const base = (req.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    const messages = this._convertMessages(req.messages || []);

    const body = {
      model: req.model.providerModel,
      messages,
      stream: true,
      max_tokens: req.maxOutputTokens || 4096,
      stream_options: { include_usage: true },
    };
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (Array.isArray(req.tools) && req.tools.length) body.tools = req.tools;

    return { url, headers, body };
  }

  /**
   * 解析豆包流式响应（OpenAI 兼容 SSE）。
   * async generator yield 统一 ChatChunk。
   * 使用 pumpSSE 按行拆分，回调中解析并通过队列异步产出。
   */
  async *parseStream(response, ctx) {
    const stream = response && response.body;
    if (!stream) {
      yield { kind: 'error', error: new AppError('upstream', '豆包响应无 body 流') };
      return;
    }

    const state = { promptTokens: 0, completionTokens: 0, gotUsage: false };
    const chunks = [];      // 缓冲行解析结果
    let pumpError = null;
    let pumpDone = false;

    // pumpSSE 按行回调；我们把解析结果推入 chunks，在 generator 里逐个 yield
    const pumpPromise = pumpSSE(stream, {
      onLine: (line) => {
        const parsed = this._parseSSELine(line, state);
        if (parsed) chunks.push(parsed);
      },
      signal: ctx && ctx.signal,
    }).then(() => { pumpDone = true; })
      .catch((e) => { pumpError = e; });

    // 边消费 pumpSSE 的回调结果边 yield
    // 由于 pumpSSE 内部 for-await 是异步的，我们需要轮询 chunks
    while (true) {
      // 先排空当前已收集的 chunks
      while (chunks.length > 0) {
        const parsed = chunks.shift();

        if (parsed.done) {
          // [DONE]
          if (state.gotUsage) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: state.promptTokens,
                completionTokens: state.completionTokens,
                totalTokens: state.promptTokens + state.completionTokens,
                usageSource: 'upstream',
              },
            };
          }
          yield { kind: 'done' };
          await pumpPromise.catch(() => {});
          return;
        }

        if (parsed.error) {
          // parsed.error 已是上游错误体（{message, type, code}），包装成 {error: {...}} 供 mapError 解析
          const err = this.mapError(200, JSON.stringify({ error: parsed.error }));
          yield { kind: 'error', error: err };
          await pumpPromise.catch(() => {});
          return;
        }

        // parsed 是 ChatChunk 数组
        if (Array.isArray(parsed)) {
          for (const c of parsed) yield c;
        }
      }

      // chunks 排空后，等 pumpSSE 推进
      if (pumpDone) break;
      if (pumpError) break;

      // 让出事件循环，让 pumpSSE 的 for-await 继续读取
      await new Promise(r => setImmediate(r));
    }

    // pumpSSE 结束后的收尾
    if (pumpError) {
      if (pumpError instanceof AppError && pumpError.code === 'cancel') {
        yield { kind: 'error', error: pumpError };
      } else {
        yield { kind: 'error', error: new AppError('network', '豆包流式解析中断', { cause: pumpError }) };
      }
      return;
    }

    // 正常结束（未收到 [DONE] 但流关闭）
    if (state.gotUsage) {
      yield {
        kind: 'usage',
        usage: {
          promptTokens: state.promptTokens,
          completionTokens: state.completionTokens,
          totalTokens: state.promptTokens + state.completionTokens,
          usageSource: 'upstream',
        },
      };
    }
    yield { kind: 'done' };
  }

  /**
   * 错误映射：豆包 Ark 的错误体通常是 { error: { code, message, type } }
   */
  mapError(status, rawText, cause) {
    let detail = '';
    try {
      const j = JSON.parse(rawText);
      detail = (j.error && (j.error.message || j.error.code)) || '';
    } catch (_) { /* ignore */ }

    if (status === 401 || status === 403) {
      return new AppError('auth', `豆包鉴权失败: ${detail || status}`);
    }
    if (status === 429) {
      return new AppError('rate', `豆包限流: ${detail || 'rate limited'}`, { retryable: true });
    }
    if (status === 400) {
      if (detail && /context|length|too many|token/i.test(detail)) {
        return new AppError('badreq', `豆包上下文超长: ${detail}`);
      }
      return new AppError('badreq', `豆包请求错误: ${detail || status}`);
    }
    if (status >= 500) {
      return new AppError('upstream', `豆包上游错误 ${status}: ${detail}`, { retryable: true });
    }
    return new AppError('upstream', `豆包错误 ${status}: ${detail}`);
  }

  /**
   * 从非流式最终载荷提取 Usage。
   * 豆包非流式响应：{ usage: { prompt_tokens, completion_tokens, total_tokens } }
   */
  extractUsage(payload) {
    if (!payload || !payload.usage) return null;
    const u = payload.usage;
    const promptTokens = u.prompt_tokens || u.input_tokens || 0;
    const completionTokens = u.completion_tokens || u.output_tokens || 0;
    if (!promptTokens && !completionTokens) return null;
    return {
      promptTokens,
      completionTokens,
      totalTokens: u.total_tokens || (promptTokens + completionTokens),
      usageSource: 'upstream',
    };
  }

  // ---------- 内部工具 ----------

  /**
   * 把统一 ChatMessage[] 转成 OpenAI 兼容 messages 数组。
   */
  _convertMessages(messages) {
    const out = [];
    for (const msg of messages) {
      const role = msg.role;
      const parts = msg.parts || [];

      if (role === 'system') {
        const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
        out.push({ role: 'system', content: text });
        continue;
      }

      if (role === 'tool') {
        const toolParts = parts.filter(p => p.type === 'tool_result');
        for (const tp of toolParts) {
          out.push({
            role: 'tool',
            content: typeof tp.content === 'string' ? tp.content : JSON.stringify(tp.content),
            tool_call_id: tp.toolCallId,
          });
        }
        continue;
      }

      const textParts = parts.filter(p => p.type === 'text');
      const imageParts = parts.filter(p => p.type === 'image');
      const toolCallParts = parts.filter(p => p.type === 'tool_call');

      if (role === 'assistant' && toolCallParts.length > 0) {
        const content = textParts.length ? textParts.map(p => p.text).join('') : null;
        const tool_calls = toolCallParts.map(tc => ({
          id: tc.toolCallId,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
          },
        }));
        out.push({ role: 'assistant', content, tool_calls });
        continue;
      }

      if (imageParts.length > 0 && role === 'user') {
        const content = [];
        for (const tp of textParts) content.push({ type: 'text', text: tp.text });
        for (const img of imageParts) {
          if (img.url) {
            content.push({ type: 'image_url', image_url: { url: img.url } });
          } else if (img.dataBase64) {
            const mime = img.mediaType || 'image/jpeg';
            content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${img.dataBase64}` } });
          }
        }
        out.push({ role: 'user', content });
        continue;
      }

      const text = textParts.map(p => p.text).join('');
      out.push({ role, content: text });
    }
    return out;
  }

  /**
   * 解析 SSE 单行，返回 null | {done:true} | {error:obj} | ChatChunk[]
   * @param {string} line 原始行（已去 \r）
   * @param {object} state 共享状态 {promptTokens, completionTokens, gotUsage}
   */
  _parseSSELine(line, state) {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).replace(/^ /, '').trim();
    if (data === '[DONE]') return { done: true };

    let j;
    try { j = JSON.parse(data); } catch (_) { return null; }

    if (j.error) return { error: j.error };

    if (j.usage) {
      state.promptTokens = j.usage.prompt_tokens || state.promptTokens;
      state.completionTokens = j.usage.completion_tokens || state.completionTokens;
      state.gotUsage = true;
    }

    const choice = j.choices && j.choices[0];
    if (!choice) return null;
    const delta = choice.delta;
    if (!delta) return null;

    const results = [];
    // 豆包部分模型回 reasoning 字段；OpenAI 系回 reasoning_content
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      results.push({ kind: 'reasoningDelta', text: reasoning });
    }
    if (delta.content) {
      results.push({ kind: 'textDelta', text: delta.content });
    }
    return results.length ? results : null;
  }
}

module.exports = { DoubaoAdapter, DEFAULT_BASE_URL };
