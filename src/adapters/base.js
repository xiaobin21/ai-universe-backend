'use strict';

/**
 * 供应商适配器抽象基类（契约 §2，第二层）。
 * 各供应商子类必须实现：capabilitiesFor / buildRequest / parseStream / mapError / extractUsage。
 * 业务层禁止出现 provider 分支；协议差异只允许在子类里。
 */

const { AppError } = require('../core/errors');

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
}

module.exports = { BaseModelAdapter };
