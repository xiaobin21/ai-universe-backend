'use strict';

/**
 * 供应商适配器抽象基类（契约 §2，第二层）。
 * 各供应商子类必须实现：capabilitiesFor / buildRequest / parseStream / mapError / extractUsage。
 * 业务层禁止出现 provider 分支；协议差异只允许在子类里。
 */

const { AppError } = require('../core/errors');
const { safeFetch } = require('../transport/httpClient');

/**
 * 读取响应体为文本。生产 safeFetch 返回 {status, body, raw(undici Response)}；
 * 测试可注入 transport 直接返回 {status, raw:{text()}}。两种形态都兼容。
 */
async function readResText(res) {
  if (!res) return '';
  try {
    if (res.raw && typeof res.raw.text === 'function') return await res.raw.text();
    const body = res.body;
    if (body && typeof body === 'object') {
      if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
      }
      if (typeof body.on === 'function') {
        return await new Promise((resolve, reject) => {
          const parts = [];
          body.on('data', (d) => parts.push(d));
          body.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
          body.on('error', reject);
        });
      }
    }
  } catch { /* 读取失败按空文本处理，由上层 JSON.parse 失败优雅降级 */ }
  return '';
}

class BaseModelAdapter {
  constructor() {
    /** @type {string|null} ProviderId（openai/anthropic/...），子类必须设置 */
    this.provider = null;
  }

  /**
   * 该供应商某模型的能力声明（兜底/默认；DB model_capabilities 可覆盖）。
   * @param {string} providerModel 供应商原生模型名
   * @returns {object} ModelCapabilities
   */
  // eslint-disable-next-line no-unused-vars
  capabilitiesFor(providerModel) {
    throw new AppError('internal', `capabilitiesFor 未实现 (${this.provider})`);
  }

  /**
   * 把内部 ChatRequest 转成上游 HTTP 请求。
   * @param {object} req ChatRequest
   * @returns {{url:string, headers:object, body:any}}
   */
  // eslint-disable-next-line no-unused-vars
  buildRequest(req) {
    throw new AppError('internal', `buildRequest 未实现 (${this.provider})`);
  }

  /**
   * 解析上游响应流，async generator yield 统一 ChatChunk。
   * @param {Response|{body:ReadableStream}} response
   * @param {object} ctx { requestId, providerModel }
   */
  // eslint-disable-next-line no-unused-vars
  async *parseStream(response, ctx) {
    throw new AppError('internal', `parseStream 未实现 (${this.provider})`);
    // 显式 generator 体（占位，便于子类覆盖）
    yield;
  }

  /**
   * 非 2xx / 网络错误 -> AppError。
   */
  // eslint-disable-next-line no-unused-vars
  mapError(status, rawText, cause) {
    if (status === 401 || status === 403) return new AppError('auth', `上游鉴权失败 (${status})`);
    if (status === 429) return new AppError('rate', '上游限流', { retryable: true });
    if (status >= 500) return new AppError('upstream', `上游错误 ${status}`, { retryable: true });
    return new AppError('upstream', `上游错误 ${status}`);
  }

  /** 从上游最终载荷提取 Usage；无则 null（由核心估算） */
  // eslint-disable-next-line no-unused-vars
  extractUsage(payload) {
    return null;
  }

  // ---------------- 可选能力：列模型（契约 §2） ----------------

  /**
   * 列模型（可选能力，默认不支持）。子类按需覆盖。
   * @param {{apiKey:string, baseUrl?:string, timeoutMs?:number, signal?:AbortSignal,
   *          transport?:Function}} [opts]
   *   transport 仅供测试注入；生产默认走统一 safeFetch（超时/取消/错误映射/SSRF）。
   * @returns {Promise<{supported:true,models:string[]} |
   *          {supported:false,reason:'unsupported'|'no_credential'|'not_found'|'auth'|'network',status?:number|null,error?:string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async listModels(opts = {}) {
    return { supported: false, reason: 'unsupported' };
  }

  /**
   * 内部：发一个 GET 列模型请求并取文本（统一超时/取消/错误映射，不重试）。
   * 网络/超时/取消在这里不抛出，交由 _openAIListModels 等捕获后优雅降级。
   */
  async _doListRequest(url, { headers = {}, timeoutMs, signal, transport } = {}) {
    const doFetch = transport || safeFetch;
    const res = await doFetch(url, {
      method: 'GET',
      headers,
      timeoutMs: timeoutMs || 15000,
      signal,
      retry: false,
    });
    const text = await readResText(res);
    return { status: res.status, text };
  }

  /** 把列模型 HTTP 状态映射为 listModels 的 reason。 */
  _classifyListStatus(status) {
    if (status === 200) return 'ok';
    if (status === 404 || status === 405) return 'not_found';
    if (status === 401 || status === 403) return 'auth';
    return 'unsupported';
  }

  /** 从 OpenAI 兼容 /models 响应提取模型 id（trim、去重、只取字符串）。 */
  _parseOpenAIModelIds(json) {
    const arr = (json && Array.isArray(json.data)) ? json.data : [];
    const seen = new Set();
    const out = [];
    for (const it of arr) {
      const id = it && typeof it.id === 'string' ? it.id.trim() : '';
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }

  /**
   * OpenAI 兼容系（openai/deepseek/qwen/zhipu/doubao/kimi/custom）共用：
   * GET {base}/models（Bearer），解析 data[].id。
   * @param {{apiKey:string, baseUrl?:string, defaultBase:string, timeoutMs?:number,
   *          signal?:AbortSignal, transport?:Function}} opts
   */
  async _openAIListModels({ apiKey, baseUrl, defaultBase, timeoutMs, signal, transport } = {}) {
    if (!apiKey) return { supported: false, reason: 'no_credential' };
    const base = String(baseUrl || defaultBase || '').replace(/\/+$/, '');
    if (!base) return { supported: false, reason: 'no_credential' };
    const url = `${base}/models`;
    try {
      const { status, text } = await this._doListRequest(url, {
        headers: { Authorization: 'Bearer ' + apiKey },
        timeoutMs, signal, transport,
      });
      if (status === 200) {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { supported: true, models: this._parseOpenAIModelIds(json) };
      }
      const reason = this._classifyListStatus(status);
      return { supported: false, reason, status };
    } catch (e) {
      // 网络/超时/取消：优雅降级，不拖垮整次发现
      return { supported: false, reason: 'network', status: null, error: String((e && e.message) || e) };
    }
  }
}

module.exports = { BaseModelAdapter };
