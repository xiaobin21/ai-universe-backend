'use strict';

/**
 * 统一错误类 AppError —— 全项目唯一错误类型（契约 §0.6 / §7）。
 * 错误码 -> HTTP 状态 + 是否可重试，集中在此，业务/适配器只传 code。
 */

const CODE_META = {
  auth:      { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  notfound:  { status: 404, retryable: false },
  rate:      { status: 429, retryable: true  },
  badreq:    { status: 400, retryable: false },
  nokey:     { status: 400, retryable: false },
  upstream:  { status: 502, retryable: true  },
  network:   { status: 502, retryable: true  },
  timeout:   { status: 504, retryable: true  },
  cancel:    { status: 499, retryable: false },
  conflict:  { status: 409, retryable: false },
  budget:    { status: 402, retryable: false },
  internal:  { status: 500, retryable: false },
};

class AppError extends Error {
  /**
   * @param {string} code 契约 §7 错误码之一
   * @param {string} message 面向用户/调用方的稳定描述（不泄露堆栈与密钥）
   * @param {{status?:number, retryable?:boolean, provider?:string, cause?:Error}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    const meta = CODE_META[code] || CODE_META.internal;
    this.name = 'AppError';
    this.code = CODE_META[code] ? code : 'internal';
    this.status = typeof opts.status === 'number' ? opts.status : meta.status;
    this.retryable = typeof opts.retryable === 'boolean' ? opts.retryable : meta.retryable;
    if (opts.provider) this.provider = opts.provider;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

module.exports = { AppError, CODE_META };
