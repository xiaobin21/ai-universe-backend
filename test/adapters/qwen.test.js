'use strict';

/**
 * Qwen 适配器单元测试（契约 §17）。
 * 不触网：用 Readable.from 构造 {body} 替代真实 HTTP 响应。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { QwenAdapter } = require('../../src/adapters/qwen');
const { AppError } = require('../../src/core/errors');

const SAMPLES_DIR = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');

function sample(name) {
  return fs.readFileSync(path.join(SAMPLES_DIR, name), 'utf8');
}

function mockResponse(text) {
  return { body: Readable.from([Buffer.from(text, 'utf8')]) };
}

async function collectChunks(adapter, sampleName, ctx = {}) {
  const res = mockResponse(sample(sampleName));
  const chunks = [];
  for await (const c of adapter.parseStream(res, ctx)) {
    chunks.push(c);
  }
  return chunks;
}

// ========== capabilitiesFor ==========

test('Qwen: capabilitiesFor qwen-plus 有 tools/struct，无 vision', () => {
  const a = new QwenAdapter();
  const cap = a.capabilitiesFor('qwen-plus');
  assert.equal(cap.supportsStreaming, true);
  assert.equal(cap.supportsTools, true);
  assert.equal(cap.supportsStructuredOutput, true);
  assert.equal(cap.supportsVision, false);
  assert.equal(cap.supportsSystemPrompt, true);
  assert.equal(cap.contextWindow, 131072);
  assert.equal(cap.maxOutputTokens, 8192);
  assert.equal(cap.toolCallFormat, 'openai');
  assert.deepEqual(cap.inputModalities, ['text']);
});

test('Qwen: capabilitiesFor qwen-vl-plus 有 vision+tools，无 struct', () => {
  const a = new QwenAdapter();
  const cap = a.capabilitiesFor('qwen-vl-plus');
  assert.equal(cap.supportsVision, true);
  assert.equal(cap.supportsTools, true);
  assert.equal(cap.supportsStructuredOutput, false);
  assert.equal(cap.contextWindow, 32768);
  assert.deepEqual(cap.inputModalities, ['text', 'image']);
  assert.deepEqual(cap.imageInputFormats, ['url']);
});

test('Qwen: capabilitiesFor qwen-turbo/max 区分 contextWindow', () => {
  const a = new QwenAdapter();
  assert.equal(a.capabilitiesFor('qwen-turbo').contextWindow, 131072);
  assert.equal(a.capabilitiesFor('qwen-max').contextWindow, 32768);
});

test('Qwen: capabilitiesFor 未知模型走兜底', () => {
  const a = new QwenAdapter();
  const cap = a.capabilitiesFor('unknown-model');
  assert.equal(cap.contextWindow, 131072);
  assert.equal(cap.supportsVision, false);
});

// ========== buildRequest ==========

test('Qwen: buildRequest 生成正确 url/headers/body', () => {
  const a = new QwenAdapter();
  const req = {
    model: { id: 'qwen-plus', provider: 'qwen', providerModel: 'qwen-plus' },
    apiKey: 'sk-test-qwen-12345',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are helpful.' }] },
      { role: 'user', parts: [{ type: 'text', text: '你好' }] },
    ],
    maxOutputTokens: 2048,
    temperature: 0.7,
  };
  const { url, headers, body } = a.buildRequest(req);
  assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-test-qwen-12345');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'qwen-plus');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.temperature, 0.7);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are helpful.');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, '你好');
});

test('Qwen: buildRequest 带图片时 content 为数组格式', () => {
  const a = new QwenAdapter();
  const req = {
    model: { providerModel: 'qwen-vl-plus' },
    apiKey: 'sk-test',
    messages: [
      { role: 'user', parts: [
        { type: 'text', text: '描述这张图' },
        { type: 'image', url: 'https://example.com/a.jpg' },
      ]},
    ],
    maxOutputTokens: 1024,
  };
  const { body } = a.buildRequest(req);
  const userMsg = body.messages[0];
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content[0].type, 'text');
  assert.equal(userMsg.content[1].type, 'image_url');
  assert.equal(userMsg.content[1].image_url.url, 'https://example.com/a.jpg');
});

test('Qwen: buildRequest 无 baseUrl 时用默认', () => {
  const a = new QwenAdapter();
  const req = {
    model: { providerModel: 'qwen-plus' },
    apiKey: 'sk-test',
    messages: [],
    maxOutputTokens: 1024,
  };
  const { url } = a.buildRequest(req);
  assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
});

// ========== parseStream ==========

test('Qwen: parseStream 正常流解析 textDelta + reasoningDelta + usage + done', async () => {
  const a = new QwenAdapter();
  const chunks = await collectChunks(a, 'qwen-normal.txt');

  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const reasoningDeltas = chunks.filter(c => c.kind === 'reasoningDelta').map(c => c.text);
  const usageChunks = chunks.filter(c => c.kind === 'usage');
  const doneChunks = chunks.filter(c => c.kind === 'done');

  assert.deepEqual(textDeltas, ['好的', '，让我来解答这个问题。', '首先，我们需要明确已知条件。']);
  assert.deepEqual(reasoningDeltas, ['用户问的是一个数学问题，让我先分析一下', '需要分步骤计算']);
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.promptTokens, 15);
  assert.equal(usageChunks[0].usage.completionTokens, 28);
  assert.equal(usageChunks[0].usage.totalTokens, 43);
  assert.equal(usageChunks[0].usage.usageSource, 'upstream');
  assert.equal(doneChunks.length, 1);
});

test('Qwen: parseStream 中途错误事件产出 error chunk', async () => {
  const a = new QwenAdapter();
  const chunks = await collectChunks(a, 'qwen-error-midstream.txt');
  const errChunks = chunks.filter(c => c.kind === 'error');
  assert.equal(errChunks.length, 1);
  assert.ok(errChunks[0].error instanceof AppError);
  assert.match(errChunks[0].error.message, /Throttling/);
});

test('Qwen: parseStream [DONE] 提前到达（无 usage）', async () => {
  const a = new QwenAdapter();
  const chunks = await collectChunks(a, 'qwen-done-early.txt');
  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const usageChunks = chunks.filter(c => c.kind === 'usage');
  const doneChunks = chunks.filter(c => c.kind === 'done');

  assert.deepEqual(textDeltas, ['Hello', ' world']);
  assert.equal(usageChunks.length, 0, '无 usage chunk');
  assert.equal(doneChunks.length, 1);
});

test('Qwen: parseStream VL 模型正常流', async () => {
  const a = new QwenAdapter();
  const chunks = await collectChunks(a, 'qwen-vl-normal.txt');
  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  assert.deepEqual(textDeltas, ['这张图片', '显示了一座山']);
  const usage = chunks.find(c => c.kind === 'usage');
  assert.equal(usage.usage.promptTokens, 250);
});

test('Qwen: parseStream 空 chunk 不崩溃', async () => {
  const a = new QwenAdapter();
  // 空响应体
  const res = { body: Readable.from([Buffer.from('', 'utf8')]) };
  const chunks = [];
  for await (const c of a.parseStream(res, {})) chunks.push(c);
  assert.equal(chunks.length, 0);
});

// ========== mapError ==========

test('Qwen: mapError 401 → auth', () => {
  const a = new QwenAdapter();
  const e = a.mapError(401, JSON.stringify({ error: { message: 'Invalid key' } }));
  assert.equal(e.code, 'auth');
  assert.equal(e.retryable, false);
  assert.match(e.message, /Invalid key/);
});

test('Qwen: mapError 429 → rate (retryable)', () => {
  const a = new QwenAdapter();
  const e = a.mapError(429, JSON.stringify({ error: { message: 'Rate limit' } }));
  assert.equal(e.code, 'rate');
  assert.equal(e.retryable, true);
});

test('Qwen: mapError 400 → badreq', () => {
  const a = new QwenAdapter();
  const e = a.mapError(400, JSON.stringify({ error: { message: 'Bad model name' } }));
  assert.equal(e.code, 'badreq');
  assert.equal(e.retryable, false);
});

test('Qwen: mapError 500 → upstream (retryable)', () => {
  const a = new QwenAdapter();
  const e = a.mapError(500, 'Internal error');
  assert.equal(e.code, 'upstream');
  assert.equal(e.retryable, true);
});

test('Qwen: mapError 非 JSON 响应体不崩溃', () => {
  const a = new QwenAdapter();
  const e = a.mapError(502, 'Bad Gateway');
  assert.equal(e.code, 'upstream');
});

// ========== extractUsage ==========

test('Qwen: extractUsage 从完整响应提取', () => {
  const a = new QwenAdapter();
  const payload = {
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  const u = a.extractUsage(payload);
  assert.equal(u.promptTokens, 100);
  assert.equal(u.completionTokens, 50);
  assert.equal(u.totalTokens, 150);
  assert.equal(u.usageSource, 'upstream');
});

test('Qwen: extractUsage 无 usage 返回 null', () => {
  const a = new QwenAdapter();
  assert.equal(a.extractUsage({}), null);
  assert.equal(a.extractUsage(null), null);
});
