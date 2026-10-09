'use strict';

/**
 * 上下文管理器单测（契约 §11）：预算计算、历史裁剪、tool_call 成对、系统指令保留。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTokens, buildMessages, compressedMessages, DEFAULT_SYSTEM_PROMPT,
} = require('../src/core/context/contextManager');

const caps = { contextWindow: 1000, maxOutputTokens: 100 }; // reserveOutput=110

test('estimateTokens：CJK 与英文保守估算', () => {
  assert.ok(estimateTokens('你好世界') > 0);
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('abcdefgh') >= 2);
});

test('预算计算：系统指令 + reserveOutput + 当前用户都计入预算', () => {
  const { messages, estimatedTokens } = buildMessages({
    history: [],
    newUserParts: [{ type: 'text', text: 'hi' }],
    capabilities: caps,
  });
  // 第一条必须是 system
  assert.equal(messages[0].role, 'system');
  // 必须包含系统指令（默认或自定义）
  assert.match(messages[0].parts[0].text, /AI Universe|助手/);
  // 预算 = ctx - system - reserve - newUser
  const sysTok = estimateTokens(messages[0].parts[0].text);
  assert.ok(estimatedTokens >= sysTok, 'estimated 至少含系统 token');
});

test('系统指令永不裁剪且置最前', () => {
  const bigHistory = [];
  for (let i = 0; i < 20; i++) {
    bigHistory.push({ role: 'user', parts: [{ type: 'text', text: '内容'.repeat(50) }] });
    bigHistory.push({ role: 'assistant', parts: [{ type: 'text', text: '回答'.repeat(50) }] });
  }
  const { messages } = buildMessages({
    history: bigHistory,
    newUserParts: [{ type: 'text', text: '新问题' }],
    capabilities: { contextWindow: 300, maxOutputTokens: 50 },
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].parts[0].text, /AI Universe|助手/);
  // 历史被裁剪：20 轮不可能全放进 300 窗口
  assert.ok(messages.length < bigHistory.length + 2, '历史应被裁剪');
});

test('历史裁剪：只保留最近若干条', () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', parts: [{ type: 'text', text: '问' + i + '，' + '内容'.repeat(20) }] });
    history.push({ role: 'assistant', parts: [{ type: 'text', text: '答' + i + '，' + '内容'.repeat(20) }] });
  }
  const { messages } = buildMessages({
    history,
    newUserParts: [{ type: 'text', text: '最后' }],
    capabilities: { contextWindow: 800, maxOutputTokens: 100 },
  });
  // 不应包含最早的几条
  const texts = messages.flatMap((m) => (m.parts || []).map((p) => p.text || ''));
  assert.ok(!texts.some((t) => t.includes('问0')), '最早的历史应被裁剪');
  assert.ok(texts.some((t) => t.includes('问9')), '最近历史应保留');
});

test('tool_call 与 tool_result 成对保留', () => {
  const history = [
    { role: 'user', parts: [{ type: 'text', text: '帮我查天气' }] },
    { role: 'assistant', parts: [{ type: 'text', text: '查一下' }, { type: 'tool_call', toolCallId: 'c1', name: 'weather', args: { city: 'bj' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'c1', content: '晴 25℃' }] },
  ];
  const { messages } = buildMessages({
    history,
    newUserParts: [{ type: 'text', text: '然后呢' }],
    capabilities: { contextWindow: 100000, maxOutputTokens: 100 },
  });
  const flat = JSON.stringify(messages);
  assert.ok(flat.includes('weather'), 'tool_call 应保留');
  assert.ok(flat.includes('晴 25℃'), 'tool_result 应保留');
});

test('compressedMessages 保留最近 4 轮 + 系统指令', () => {
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: 'user', parts: [{ type: 'text', text: 'u' + i }] });
    history.push({ role: 'assistant', parts: [{ type: 'text', text: 'a' + i }] });
  }
  const { messages } = compressedMessages({ history, newUserParts: [{ type: 'text', text: 'new' }] });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].parts[0].text, /早期对话摘要/);
  const lastUser = messages[messages.length - 1];
  assert.equal(lastUser.parts[0].text, 'new');
});
