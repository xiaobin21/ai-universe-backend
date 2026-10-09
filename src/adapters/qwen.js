'use strict';

/**
 * Qwen（通义千问）适配器 —— DashScope 兼容模式（契约 §2.1）。
 * 鉴权：Bearer；端点：{base}/chat/completions；SSE 与 OpenAI 一致。
 * 思考链：delta.reasoning_content → reasoningDelta。
 * 注意：虽 OpenAI 兼容，但错误码/用量字段需独立解析，不假设全功能一致。
 */

const { BaseModelAdapter } = require('./base');
const { AppError } = require('../core/errors');
const { pumpSSE } = require('../transport/sse');

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 模型能力表（兜底/默认；DB model_capabilities 可覆盖） */
const MODEL_CAPS = {
  'qwen-plus':    { contextWindow: 131072, maxOutputTokens: 8192, supportsTools: true,  supportsStructuredOutput: true,  supportsVision: false },
  'qwen-turbo':   { contextWindow: 131072, maxOutputTokens: 8192, supportsTools: true,  supportsStructuredOutput: true,  supportsVision: false },
  'qwen-max':     { contextWindow: 32768,  maxOutputTokens: 8192, supportsTools: true,  supportsStructuredOutput: true,  supportsVision: false },
  'qwen-vl-plus': { contextWindow: 32768,  maxOutputTokens: 8192, supportsTools: true,  supportsStructuredOutput: false, supportsVision: true  },
};

/** 把内部多部分消息转成 OpenAI 兼容 messages（Qwen 系共用） */
function toOpenAIMessages(messages) {
  const out = [];
  for (const msg of messages) {
    const parts = msg.parts || [];

    if (msg.role === 'system') {
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      out.push({ role: 'system', content: text });
      continue;
    }
    if (msg.role === 'user') {
      const textParts = parts.filter(p => p.type === 'text');
      const imageParts = parts.filter(p => p.type === 'image');
      if (imageParts.length) {
        const content = [];
        for (const tp of textParts) content.push({ type: 'text', text: tp.text });
        for (const ip of imageParts) {
          const url = ip.url || (ip.dataBase64 ? `data:${ip.mediaType || 'image/jpeg'};base64,${ip.dataBase64}` : '');
          content.push({ type: 'image_url', image_url: { url } });
        }
        out.push({ role: 'user', content });
      } else {
        out.push({ role: 'user', content: textParts.map(p => p.text).join('') });
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const textParts = parts.filter(p => p.type === 'text');
      const toolCallParts = parts.filter(p => p.type === 'tool_call');
      const content = textParts.length ? textParts.map(p => p.text).join('') : null;
      if (toolCallParts.length) {
        out.push({
          role: 'assistant', content,
          tool_calls: toolCallParts.map(p => ({
            id: p.toolCallId, type: 'function',
            function: { name: p.name, arguments: JSON.stringify(p.args || {}) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content });
      }
      continue;
    }
    if (msg.role === 'tool') {
      const resultParts = parts.filter(p => p.type === 'tool_result');
      out.push({
        role: 'tool',
        tool_call_id: resultParts[0]?.toolCallId || '',
        content: resultParts.map(p => p.content).join(''),
      });
      continue;
    }
  }
  return out;
}

/**
 * 把 pumpSSE 回调桥接到 async generator。
 * onLine 同步回调解析出的 ChatChunk 推入队列，generator 按序 yield。
 */
async function* sseToGenerator(stream, parseLine, signal) {
  const queue = [];
  let waiter = null, finished = false, failure = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  pumpSSE(stream, {
    onLine: (line) => {
      const chunk = parseLine(line);
      if (chunk) { queue.push(chunk); wake(); }
    },
    signal,
  }).then(() => { finished = true; wake(); })
    .catch(err => { failure = err; wake(); });

  while (true) {
    if (queue.length) { yield queue.shift(); continue; }
    if (finished) break;
    if (failure) throw failure;
    await new Promise(r => { waiter = r; });
  }
}

class QwenAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'qwen';
  }

  capabilitiesFor(providerModel) {
    const cap = MODEL_CAPS[providerModel] || {};
    const hasVision = Boolean(cap.supportsVision);
    return {
      supportsStreaming: true,
      supportsTools: Boolean(cap.supportsTools),
      supportsVision: hasVision,
      supportsSystemPrompt: true,
      supportsThinking: false,
      supportsStructuredOutput: Boolean(cap.supportsStructuredOutput),
      contextWindow: cap.contextWindow || 131072,
      maxOutputTokens: cap.maxOutputTokens || 8192,
      imageInputFormats: hasVision ? ['url'] : [],
      toolCallFormat: 'openai',
      inputModalities: hasVision ? ['text', 'image'] : ['text'],
      outputModalities: ['text'],
    };
  }

  /** 列模型（契约 §2）：GET {base}/models，解析 data[].id。 */
  async listModels(opts = {}) {
    return this._openAIListModels({ ...opts, defaultBase: DEFAULT_BASE });
  }

  buildRequest(req) {
    const baseUrl = (req.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const body = {
      model: req.model.providerModel,
      messages: toOpenAIMessages(req.messages || []),
      stream: true,
      max_tokens: req.maxOutputTokens,
      stream_options: { include_usage: true },
    };
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.tools && req.tools.length) body.tools = req.tools;

    return {
      url: baseUrl + '/chat/completions',
      headers: {
        'Authorization': 'Bearer ' + req.apiKey,
        'Content-Type': 'application/json',
      },
      body,
    };
  }

  async *parseStream(response, ctx) {
    const parseLine = (line) => {
      if (!line.startsWith('data:')) return null;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { kind: 'done' };

      let j;
      try { j = JSON.parse(data); } catch (_) { return null; }

      // 上游错误事件（中途）
      if (j.error) {
        return { kind: 'error', error: this.mapError(200, JSON.stringify(j.error), null) };
      }

      // 用量（最后一个 chunk）
      if (j.usage) {
        return {
          kind: 'usage',
          usage: {
            promptTokens: j.usage.prompt_tokens || 0,
            completionTokens: j.usage.completion_tokens || 0,
            totalTokens: j.usage.total_tokens || 0,
            usageSource: 'upstream',
          },
        };
      }

      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) return null;

      if (delta.reasoning_content) {
        return { kind: 'reasoningDelta', text: delta.reasoning_content };
      }
      if (delta.content) {
        return { kind: 'textDelta', text: delta.content };
      }
      return null;
    };

    yield* sseToGenerator(response.body, parseLine, ctx && ctx.signal);
  }

  mapError(status, rawText, cause) {
    let detail = '';
    try {
      const j = JSON.parse(rawText);
      detail = j.error?.message || j.message || '';
    } catch (_) { /* ignore */ }

    if (status === 401 || status === 403) {
      return new AppError('auth', `Qwen 鉴权失败 (${status})${detail ? ': ' + detail : ''}`, { cause });
    }
    if (status === 429) {
      return new AppError('rate', `Qwen 限流${detail ? ': ' + detail : ''}`, { retryable: true, cause });
    }
    if (status === 400) {
      return new AppError('badreq', `Qwen 请求错误${detail ? ': ' + detail : ''}`, { cause });
    }
    if (status >= 500) {
      return new AppError('upstream', `Qwen 上游错误 ${status}`, { retryable: true, cause });
    }
    return new AppError('upstream', `Qwen 上游错误 ${status}${detail ? ': ' + detail : ''}`, { cause });
  }

  extractUsage(payload) {
    if (!payload || !payload.usage) return null;
    const u = payload.usage;
    const promptTokens = u.prompt_tokens || 0;
    const completionTokens = u.completion_tokens || 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: u.total_tokens || (promptTokens + completionTokens),
      usageSource: 'upstream',
    };
  }
}

module.exports = { QwenAdapter, toOpenAIMessages };
