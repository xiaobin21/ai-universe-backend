'use strict';

/**
 * 上下文管理器（契约 §11）。
 *
 *  buildMessages({ systemText, history, newUserParts, capabilities })
 *    -> { messages:[ChatMessage], estimatedTokens }
 *  - 读 capabilities.contextWindow / maxOutputTokens；reserveOutput = round(maxOut * 1.1)
 *  - 系统安全指令 token 固定预算、永不裁剪，置于最前（排除在裁剪逻辑外）
 *  - available = ctx - systemTokens - reserveOutput - newUserTokens(-attachments)
 *  - 从最近历史向前累加直到 available 用尽；更早历史丢弃（摘要由 compressedMessages 提供）
 *  - tool_call 与 tool_result 成对保留，禁止拆开
 *  - 不按字符硬截断；token 估算见 tokenEstimate
 *
 *  compressedMessages(...)：保留系统指令 + 摘要占位 + 最近 4 条历史（上下文长度错误重试一次用）。
 */

const { estimateTokens } = require('../billing/tokenEstimate');

/** 默认系统安全指令（永不裁剪、置最前）。 */
const DEFAULT_SYSTEM_PROMPT =
  '你是 AI Universe 多模型 AI 助手。请以安全、诚实、有帮助的方式回答；' +
  '拒绝协助任何违法、自残或侵犯他人权益的行为；不知道就明确说明不确定。';

/** 单条 part 的 token 估算（图片 ~1200/张）。 */
function partTokens(p) {
  if (!p || typeof p !== 'object') return 0;
  switch (p.type) {
    case 'text':
    case 'reasoning':
    case 'refusal':
      return estimateTokens(p.text || '');
    case 'tool_call':
      return estimateTokens((p.name || '') + ' ' + JSON.stringify(p.args || {}));
    case 'tool_result':
      return estimateTokens(typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? ''));
    case 'image':
      return 1200;
    case 'attachment':
      return estimateTokens(p.text || p.name || '');
    default:
      return 0;
  }
}

function messageTokens(msg) {
  return (msg.parts || []).reduce((s, p) => s + partTokens(p), 0);
}

function messageHasToolCall(msg) {
  return (msg.parts || []).some((p) => p.type === 'tool_call');
}

function systemMessage(systemText) {
  return { role: 'system', parts: [{ type: 'text', text: systemText || DEFAULT_SYSTEM_PROMPT }] };
}

/**
 * @param {{systemText?:string, history:object[], newUserParts:object[], capabilities:object}} args
 * @returns {{messages:object[], estimatedTokens:number}}
 */
function buildMessages({ systemText, history = [], newUserParts = [], capabilities = {} }) {
  const systemTextFinal = systemText || DEFAULT_SYSTEM_PROMPT;
  const sysMsg = systemMessage(systemTextFinal);

  const ctxWindow = Number(capabilities.contextWindow) || 8192;
  const maxOut = Number(capabilities.maxOutputTokens) || 4096;
  const reserveOutput = Math.round(maxOut * 1.1);

  const systemTokens = estimateTokens(sysMsg.parts[0].text);
  const newUserTokens = (newUserParts || []).reduce((s, p) => s + partTokens(p), 0);

  let available = ctxWindow - systemTokens - reserveOutput - newUserTokens;
  if (available < 0) available = 0;

  // 从最近历史向前挑选，tool_call/tool_result 成对保留
  const keep = new Set();
  let used = 0;
  const h = history;

  const pairCost = (i) => {
    const idxs = new Set([i]);
    // tool_result 必须连带其前一条 assistant（tool_call）
    if (h[i] && h[i].role === 'tool') idxs.add(i - 1);
    // 含 tool_call 的 assistant 必须连带其后的 tool_result
    if (h[i] && h[i].role === 'assistant' && messageHasToolCall(h[i]) && h[i + 1] && h[i + 1].role === 'tool') {
      idxs.add(i + 1);
    }
    let cost = 0;
    for (const j of idxs) if (j >= 0 && j < h.length) cost += messageTokens(h[j]);
    return { idxs, cost };
  };

  for (let i = h.length - 1; i >= 0; i--) {
    const { idxs, cost } = pairCost(i);
    const willFit = used + cost <= available;
    // 至少保留一条最近历史，即使单条就超预算（避免历史被完全清空）
    if (!willFit && keep.size > 0) break;
    for (const j of idxs) {
      if (j >= 0 && j < h.length && !keep.has(j)) {
        keep.add(j);
        used += messageTokens(h[j]);
      }
    }
  }

  const orderedHistory = [...keep].sort((a, b) => a - b).map((j) => h[j]);
  const newMsg = { role: 'user', parts: newUserParts || [] };
  const messages = [sysMsg, ...orderedHistory, newMsg];

  const estimatedTokens = systemTokens + used + newUserTokens;
  return { messages, estimatedTokens, available, usedHistoryTokens: used };
}

/**
 * 压缩重试（§11.8）：保留系统指令 + 摘要占位 + 最近 4 条历史。
 * @param {{systemText?:string, history:object[], newUserParts:object[]}} args
 */
function compressedMessages({ systemText, history = [], newUserParts = [] } = {}) {
  const sysMsg = systemMessage(systemText);
  const summaryMsg = {
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '[早期对话摘要] 本次请求超出模型上下文窗口，更早的对话历史已被压缩省略，仅保留最近 4 轮。',
      },
    ],
  };
  const last4 = history.slice(-4);
  const newMsg = { role: 'user', parts: newUserParts || [] };
  const messages = [sysMsg, summaryMsg, ...last4, newMsg];
  const estimatedTokens = messages.reduce((s, m) => s + messageTokens(m), 0);
  return { messages, estimatedTokens };
}

module.exports = {
  estimateTokens,
  buildMessages,
  compressedMessages,
  partTokens,
  messageTokens,
  DEFAULT_SYSTEM_PROMPT,
};
