'use strict';

/**
 * 日志脱敏（契约 §4.2）。任何写日志前都应过 redactObject。
 * 绝不把 authorization / x-api-key / cookie token / 密码 / 完整 API Key 打进日志。
 */

const SENSITIVE_KEY_RE = /^(authorization|x-api-key|proxy-authorization|cookie|set-cookie|api[_-]?key|key|secret|password|token|access[_-]?token|refresh[_-]?token)$/i;
const MASK = '***masked***';

function redactValue(v) {
  if (typeof v === 'string') {
    // 保留前 4 后 4 便于排障，中间打码
    if (v.length <= 8) return MASK;
    return `${v.slice(0, 4)}***${v.slice(-4)}`;
  }
  return MASK;
}

/**
 * 递归脱敏对象；数组/对象深拷贝式返回，不污染原对象。
 * @param {any} obj
 * @param {number} [depth] 内部递归深度保护
 */
function redactObject(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((x) => redactObject(x, depth + 1));
  if (obj instanceof Error) return { name: obj.name, message: obj.message, code: obj.code };
  if (typeof obj !== 'object') return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = MASK;
    } else if (v && typeof v === 'object') {
      out[k] = redactObject(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { redactObject, redactValue };
