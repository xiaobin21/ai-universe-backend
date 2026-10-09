'use strict';

/**
 * 进程内限流（契约 §4.3）：滑动窗口（固定窗口+队列裁剪）实现。
 *
 * 重要局限：
 *  - 全部状态在 Node 进程内存里。单实例（Render 免费/标准 Web Service 单实例）可用；
 *  - 一旦水平扩成多个实例，每个实例各记各的，阈值必须按实例数等比放大，
 *    或迁移到 Redis（推荐 Render Redis）/Postgres 计数器。
 *  - 重启即清零，因此只适用于「粗粒度防爆破」，不作为强一致配额。
 *
 * 导出：
 *   createRateLimiter({ windowMs, max }) -> { hit(key) -> {allowed, remaining, retryAfterMs} }
 *   rateLimit({ keyBy, windowMs, max }) -> express 中间件
 */

const { AppError } = require('../errors');

/**
 * @param {{windowMs:number, max:number}} opts
 */
function createRateLimiter({ windowMs, max }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new AppError('internal', 'createRateLimiter: windowMs 必须为正数');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new AppError('internal', 'createRateLimiter: max 必须为正整数');
  }
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  let lastPrune = Date.now();

  function hit(key) {
    const now = Date.now();
    // 低频顺带清理过期 key，防止 Map 无限增长（单实例下可接受）
    if (now - lastPrune > windowMs) {
      const cutoff = now - windowMs;
      for (const [k, arr] of buckets) {
        while (arr.length && arr[0] <= cutoff) arr.shift();
        if (arr.length === 0) buckets.delete(k);
      }
      lastPrune = now;
    }

    const cutoff = now - windowMs;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    } else {
      while (arr.length && arr[0] <= cutoff) arr.shift();
    }

    if (arr.length >= max) {
      const retryAfterMs = Math.max(0, arr[0] + windowMs - now);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    arr.push(now);
    return { allowed: true, remaining: Math.max(0, max - arr.length), retryAfterMs: 0 };
  }

  return { hit };
}

/**
 * Express 中间件工厂。
 * @param {{keyBy:(req:any)=>string, windowMs:number, max:number, message?:string}} opts
 */
function rateLimit({ keyBy, windowMs, max, message } = {}) {
  if (typeof keyBy !== 'function') {
    throw new AppError('internal', 'rateLimit: keyBy 必须是 (req)=>string');
  }
  const limiter = createRateLimiter({ windowMs, max });
  return function rateLimitMiddleware(req, res, next) {
    const key = keyBy(req) || 'anonymous';
    const r = limiter.hit(key);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      return next(new AppError('rate', message || '请求过于频繁，请稍后再试'));
    }
    next();
  };
}

module.exports = { createRateLimiter, rateLimit };
