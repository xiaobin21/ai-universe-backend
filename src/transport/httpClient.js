'use strict';

/**
 * 统一出站 HTTP 客户端（契约 §3.1，第三层传输）。
 *
 * 所有对供应商的请求必须经 safeFetch：
 *  - SSRF 双闸：URL 静态校验 + undici connect.lookup 替换为 guardedLookup（建 TCP 时再校验 IP）
 *  - 仅 https；http 仅 allowInsecure（本地模式）
 *  - 统一超时（默认 120s），与外部 AbortSignal 合并
 *  - 手动处理 3xx（undici maxRedirections:0），每跳 Location 重走 SSRF 校验
 *  - 自动注入 X-Request-ID；剥除 host / x-forwarded-* 等危险头
 *  - 仅对网络错误/超时/429/5xx 做最多 2 次指数退避重试（流式调用方应在开始读流后设 retry:false）
 */

const crypto = require('node:crypto');
const { Agent, fetch: undiciFetch } = require('undici');
const { AppError } = require('../core/errors');
const { assertUrlAllowed, createGuardedLookup } = require('../core/security/ssrf');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const MAX_RETRIES = 2;

// 剥除这些请求头（防止用户/适配器注入主机或代理头）
const STRIP_HEADER_RE = /^(host|content-length|connection|x-forwarded-(for|host|proto|port))$/i;

function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP_HEADER_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function classifyError(e) {
  if (e instanceof AppError) return e;
  const name = (e && e.name) || '';
  if (name === 'AbortError' || /aborted|abort/i.test(name)) {
    // 由我们自己的超时或外部 signal 触发，上层再区分；这里先标 timeout/network
    if (e && e.message && /timeout|超时/i.test(e.message)) {
      return new AppError('timeout', '上游请求超时', { cause: e });
    }
    return new AppError('cancel', '请求已取消', { cause: e });
  }
  return new AppError('network', `网络错误: ${e && e.message}`, { cause: e });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个带 SSRF 守卫的 fetch 客户端。
 * @param {{allowInsecure?:boolean, profile?:string, resolver?:Function, fetchImpl?:Function, agent?:any}} [opts]
 *   fetchImpl/agent 主要供测试注入；生产用 undici 默认。
 */
function createSafeClient(opts = {}) {
  const baseAllowInsecure = Boolean(opts.allowInsecure);
  const profile = opts.profile || 'default';
  const lookup = createGuardedLookup({
    allowInsecure: baseAllowInsecure,
    profile,
    resolver: opts.resolver,
  });
  const fetchImpl = opts.fetchImpl || undiciFetch;
  const agent = opts.agent || new Agent({ connect: { lookup } });

  async function doOne(rawUrl, options, requestId) {
    const method = (options.method || 'GET').toUpperCase();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AppError('timeout', '上游请求超时')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const onExtAbort = () => controller.abort(new AppError('cancel', '外部取消'));
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new AppError('cancel', '外部取消');
      }
      options.signal.addEventListener('abort', onExtAbort, { once: true });
    }
    try {
      const headers = sanitizeHeaders(options.headers || {});
      headers['x-request-id'] = requestId;
      const res = await fetchImpl(rawUrl, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
        dispatcher: agent,
        maxRedirections: 0,
      });
      return res;
    } catch (e) {
      throw classifyError(e);
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onExtAbort);
    }
  }

  /**
   * @param {string} rawUrl
   * @param {{method?:string, headers?:object, body?:any, signal?:AbortSignal, timeoutMs?:number,
   *          maxRedirects?:number, allowInsecure?:boolean, requestId?:string, retry?:boolean}} [options]
   * @returns {Promise<{status:number, headers:any, body:ReadableStream, raw:any}>}
   */
  return async function safeFetch(rawUrl, options = {}) {
    const requestId = options.requestId || crypto.randomUUID();
    const allowInsecure = options.allowInsecure ?? baseAllowInsecure;
    const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    const retry = options.retry !== false;

    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // 每跳（含首次与每次重定向）都走完整 SSRF 静态校验
      assertUrlAllowed(current, { allowInsecure, profile });

      let attempt = 0;
      let res;
      for (;;) {
        try {
          res = await doOne(current, options, requestId);
        } catch (e) {
          const retryable =
            retry &&
            attempt < MAX_RETRIES &&
            (e.code === 'network' || e.code === 'timeout' || e.code === 'rate' || e.code === 'upstream');
          if (!retryable) throw e;
          attempt += 1;
          await sleep(150 * 2 ** (attempt - 1));
          continue;
        }
        break;
      }

      // 3xx 手动跟随；undici maxRedirections:0 时 undici 自身也可能直接返回 3xx
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (!loc) throw new AppError('upstream', `重定向缺少 Location（${res.status}）`);
        current = new URL(loc, current).toString();
        continue; // 下一轮 assertUrlAllowed 重校
      }

      return { status: res.status, headers: res.headers, body: res.body, raw: res, requestId };
    }
    throw new AppError('upstream', `重定向超过 ${maxRedirects} 次`);
  };
}

// 模块级默认客户端：从 env 读策略
const envAllowInsecure = Boolean(
  process.env.ALLOW_INSECURE_LOCAL_MODE === 'true' || process.env.ALLOW_INSECURE_LOCAL_MODE === '1'
);
const safeFetch = createSafeClient({ allowInsecure: envAllowInsecure });

module.exports = { safeFetch, createSafeClient };
