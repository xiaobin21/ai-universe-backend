'use strict';

/**
 * 全项目统一 Token 估算器（契约 §11.6 / §13）。
 * 无官方 tokenizer 时的保守估算：
 *   - CJK（中日韩统一表意文字 + 扩展 A + 兼容表意文字）≈ 1.5 token/字
 *   - 其余字符（拉丁、数字、标点、空白等）≈ 1 token / 4 字符
 *   - 结果向上取整（ceil），保证「宁多勿少」的保守预算。
 *
 * 纯函数、不依赖 DB，可被上下文管理器、billing、router 复用。
 */

// CJK 表意文字：扩展A(3400-4DBF)、基本区(4E00-9FFF)、兼容表意文字(F900-FAFF)
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

/**
 * 估算一段文本的 token 数（保守）。
 * @param {string|number|null|undefined} text
 * @returns {number} 非负整数 token
 */
function estimateTokens(text) {
  if (text === null || text === undefined) return 0;
  const s = String(text);
  if (s.length === 0) return 0;
  const cjk = (s.match(CJK_RE) || []).length;
  const other = s.length - cjk;
  // 分别计 token 再相加，最后 ceil；中间用浮点仅用于估算，不涉及金额
  const raw = cjk * 1.5 + other / 4;
  return Math.max(0, Math.ceil(raw));
}

module.exports = { estimateTokens };
