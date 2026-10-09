'use strict';

/**
 * 自定义 OpenAI 兼容适配器 —— 由核心按用户自定义凭证直接实例化，不注册到 registry。
 * 契约 §2.1 末行：custom | Bearer（用户给） | 用户 base + /chat/completions | OpenAI | OpenAI | 按 capabilities 配置
 *
 * 构造时接收运行时配置：
 *   {
 *     baseUrl: 'https://user-provided.example.com/v1',
 *     apiKey: 'sk-...',
 *     capabilities: { ...ModelCapabilities 子集... }   // 可部分覆盖，缺省给合理默认
 *   }
 *
 * 该类不写死任何供应商信息；所有行为由构造参数决定。
 * 出站 URL 由传输层 safeFetch 过 SSRF；本类只产出 url，不直接发请求。
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

class CustomOpenAICompatibleAdapter extends BaseModelAdapter {
  /**
   * @param {{baseUrl:string, apiKey:string, capabilities?:object}} config
   */
  constructor(config) {
    super();
    this.provider = 'custom'; // 标识用，不进 registry

    if (!config || typeof config !== 'object') {
      throw new AppError('badreq', '自定义适配器需传入配置 {baseUrl, apiKey}');
    }
    if (!config.baseUrl) {
      throw new AppError('badreq', '自定义适配器缺少 baseUrl');
    }
    if (!config.apiKey) {
      throw new AppError('nokey', '自定义适配器缺少 apiKey');
    }

    this._baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    this._apiKey = config.apiKey;
    this._capabilitiesOverrides = config.capabilities || {};
  }

  /**
   * 能力声明：用构造时传入的 capabilities 覆盖默认值。
   * 默认：streaming=true, systemPrompt=true, 其余 false/安全值。
   */
  capabilitiesFor(providerModel) {
    const ov = this._capabilitiesOverrides;
    return {
      supportsStreaming: ov.supportsStreaming !== false, // 默认 true
      supportsTools: !!ov.supportsTools,
      supportsVision: !!ov.supportsVision,
      supportsSystemPrompt: ov.supportsSystemPrompt !== false, // 默认 true
      supportsThinking: !!ov.supportsThinking,
      supportsStructuredOutput: !!ov.supportsStructuredOutput,
      contextWindow: ov.contextWindow || 4096,
      maxOutputTokens: ov.maxOutputTokens || 4096,
      imageInputFormats: Array.isArray(ov.imageInputFormats) ? ov.imageInputFormats : [],
      toolCallFormat: ov.toolCallFormat || 'openai',
      inputModalities: Array.isArray(ov.inputModalities) ? ov.inputModalities : ['text'],
      outputModalities: Array.isArray(ov.outputModalities) ? ov.outputModalities : ['text'],
    };
  }

  /**
   * ChatRequest -> { url, headers, body }
   * 使用构造时传入的 baseUrl 和 apiKey。
   */
  buildRequest(req) {
    const url = `${this._baseUrl}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._apiKey}`,
    };

    const messages = this._convertMessages(req.messages || []);

    const caps = this.capabilitiesFor(req.model.providerModel);
    const body = {
      model: req.model.providerModel,
      messages,
      stream: caps.supportsStreaming,
      max_tokens: req.maxOutputTokens || caps.maxOutputTokens,
    };
    if (caps.supportsStreaming) {
      body.stream_options = { include_usage: true };
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (Array.isArray(req.tools) && req.tools.length && caps.supportsTools) {
      body.tools = req.tools;
    }

    return { url, headers, body };
  }

  /**
   * 解析标准 OpenAI SSE 流。
   * data: {...} / data: [DONE] / delta.content / 可选 reasoning_content / usage
   */
  async *parseStream(response, ctx) {
    const stream = response && response.body;
    if (!stream) {
      yield { kind: 'error', error: new AppError('upstream', '自定义 OpenAI 兼容响应无 body 流') };
      return;
    }

    const state = { promptTokens: 0, completionTokens: 0, gotUsage: false };
    const chunks = [];
    let pumpError = null;
    let pumpDone = false;

    const pumpPromise = pumpSSE(stream, {
      onLine: (line) => {
        const parsed = this._parseSSELine(line, state);
        if (parsed) chunks.push(parsed);
      },
      signal: ctx && ctx.signal,
    }).then(() => { pumpDone = true; })
      .catch((e) => { pumpError = e; });

    while (true) {
      while (chunks.length > 0) {
        const parsed = chunks.shift();

        if (parsed.done) {
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

        if (Array.isArray(parsed)) {
          for (const c of parsed) yield c;
        }
      }

      if (pumpDone) break;
      if (pumpError) break;
      await new Promise(r => setImmediate(r));
    }

    if (pumpError) {
      if (pumpError instanceof AppError && pumpError.code === 'cancel') {
        yield { kind: 'error', error: pumpError };
      } else {
        yield { kind: 'error', error: new AppError('network', '自定义 OpenAI 兼容流解析中断', { cause: pumpError }) };
      }
      return;
    }

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
   * 错误映射：标准 OpenAI 错误体 { error: { message, type, code } }
   */
  mapError(status, rawText, cause) {
    let detail = '';
    try {
      const j = JSON.parse(rawText);
      detail = (j.error && (j.error.message || j.error.code)) || '';
    } catch (_) { /* ignore */ }

    if (status === 401 || status === 403) {
      return new AppError('auth', `自定义接口鉴权失败: ${detail || status}`);
    }
    if (status === 429) {
      return new AppError('rate', `自定义接口限流: ${detail || 'rate limited'}`, { retryable: true });
    }
    if (status === 400) {
      if (detail && /context|length|too many|token/i.test(detail)) {
        return new AppError('badreq', `自定义接口上下文超长: ${detail}`);
      }
      return new AppError('badreq', `自定义接口请求错误: ${detail || status}`);
    }
    if (status >= 500) {
      return new AppError('upstream', `自定义接口上游错误 ${status}: ${detail}`, { retryable: true });
    }
    return new AppError('upstream', `自定义接口错误 ${status}: ${detail}`);
  }

  /**
   * 从非流式最终载荷提取 Usage。
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
   * 解析 SSE 单行 —— 标准 OpenAI 格式。
   * 同时兼容 reasoning_content 与 reasoning 字段。
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

module.exports = { CustomOpenAICompatibleAdapter };
