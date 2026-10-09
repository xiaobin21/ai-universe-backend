'use strict';

/**
 * Kimi（Moonshot）适配器单元测试（契约 §17）。
 * 不触网：用 Readable.from 构造 {body} 替代真实 HTTP 响应。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { KimiAdapter } = require('../../src/adapters/kimi');
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

test('Kimi: capabilitiesFor moonshot-v1-8k 无 tools/vision/struct/thinking', () => {
  const a = new KimiAdapter();
  const cap = a.capabilitiesFor('moonshot-v1-8k');
  assert.equal(cap.supportsStreaming, true);
  assert.equal(cap.supportsTools, false);
  assert.equal(cap.supportsVision, false);
  assert.equal(cap.supportsStructuredOutput, false);
  assert.equal(cap.supportsThinking, false);
  assert.equal(cap.supportsSystemPrompt, true);
  assert.equal(cap.contextWindow, 8192);
  assert.equal(cap.maxOutputTokens, 4096);
  assert.deepEqual(cap.inputModalities, ['text']);
  assert.deepEqual(cap.imageInputFormats, []);
});

test('Kimi: capabilitiesFor 不同模型区分 contextWindow', () => {
  const a = new KimiAdapter();
  assert.equal(a.capabilitiesFor('moonshot-v1-8k').contextWindow, 8192);
  assert.equal(a.capabilitiesFor('moonshot-v1-32k').contextWindow, 32768);
  assert.equal(a.capabilitiesFor('moonshot-v1-128k').contextWindow, 131072);
});

test('Kimi: capabilitiesFor 所有模型 flags 一致（均无额外能力）', () => {
  const a = new KimiAdapter();
  for (const model of ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']) {
    const cap = a.capabilitiesFor(model);
    assert.equal(cap.supportsTools, false, `${model} should not support tools`);
    assert.equal(cap.supportsVision, false, `${model} should not support vision`);
    assert.equal(cap.supportsStructuredOutput, false, `${model} should not support struct`);
  }
});

test('Kimi: capabilitiesFor 未知模型走兜底', () => {
  const a = new KimiAdapter();
  const cap = a.capabilitiesFor('unknown-kimi');
  assert.equal(cap.contextWindow, 32768);
  assert.equal(cap.supportsTools, false);
});

// ========== buildRequest ==========

test('Kimi: buildRequest 生成正确 url/headers/body', () => {
  const a = new KimiAdapter();
  const req = {
    model: { id: 'kimi-8k', provider: 'kimi', providerModel: 'moonshot-v1-8k' },
    apiKey: 'sk-moonshot-test-67890',
    baseUrl: 'https://api.moonshot.cn/v1',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are Kimi.' }] },
      { role: 'user', parts: [{ type: 'text', text: '你好，Kimi' }] },
    ],
    maxOutputTokens: 2048,
    temperature: 0.3,
  };
  const { url, headers, body } = a.buildRequest(req);
  assert.equal(url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-moonshot-test-67890');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'moonshot-v1-8k');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.temperature, 0.3);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, '你好，Kimi');
});

test('Kimi: buildRequest 不发送 tools（即使传入）', () => {
  const a = new KimiAdapter();
  const req = {
    model: { providerModel: 'moonshot-v1-8k' },
    apiKey: 'sk-test',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    maxOutputTokens: 1024,
    tools: [{ type: 'function', function: { name: 'search' } }],
  };
  const { body } = a.buildRequest(req);
  assert.equal(body.tools, undefined, 'Kimi 不支持 tools，不应发送');
});

test('Kimi: buildRequest 图片消息忽略图片部分（仅文本）', () => {
  const a = new KimiAdapter();
  const req = {
    model: { providerModel: 'moonshot-v1-32k' },
    apiKey: 'sk-test',
    messages: [
      { role: 'user', parts: [
        { type: 'text', text: '看这张图' },
        { type: 'image', url: 'https://example.com/a.jpg' },
      ]},
    ],
    maxOutputTokens: 1024,
  };
  const { body } = a.buildRequest(req);
  const userMsg = body.messages[0];
  assert.equal(typeof userMsg.content, 'string', 'Kimi 不支持图片，content 应为字符串');
  assert.equal(userMsg.content, '看这张图');
});

test('Kimi: buildRequest 无 baseUrl 时用默认', () => {
  const a = new KimiAdapter();
  const req = {
    model: { providerModel: 'moonshot-v1-128k' },
    apiKey: 'sk-test',
    messages: [],
    maxOutputTokens: 1024,
  };
  const { url } = a.buildRequest(req);
  assert.equal(url, 'https://api.moonshot.cn/v1/chat/completions');
});

// ========== parseStream ==========

test('Kimi: parseStream 正常流解析 textDelta + usage + done（无 reasoning）', async () => {
  const a = new KimiAdapter();
  const chunks = await collectChunks(a, 'kimi-normal.txt');

  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const reasoningDeltas = chunks.filter(c => c.kind === 'reasoningDelta');
  const usageChunks = chunks.filter(c => c.kind === 'usage');
  const doneChunks = chunks.filter(c => c.kind === 'done');

  assert.deepEqual(textDeltas, ['你好！', '很高兴为你服务。', '请问有什么可以帮你的？']);
  assert.equal(reasoningDeltas.length, 0, 'Kimi 无思考链');
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.promptTokens, 12);
  assert.equal(usageChunks[0].usage.completionTokens, 20);
  assert.equal(usageChunks[0].usage.totalTokens, 32);
  assert.equal(usageChunks[0].usage.usageSource, 'upstream');
  assert.equal(doneChunks.length, 1);
});

test('Kimi: parseStream 中途错误事件产出 error chunk', async () => {
  const a = new KimiAdapter();
  const chunks = await collectChunks(a, 'kimi-error-midstream.txt');
  const errChunks = chunks.filter(c => c.kind === 'error');
  assert.equal(errChunks.length, 1);
  assert.ok(errChunks[0].error instanceof AppError);
  assert.match(errChunks[0].error.message, /Rate limit/);
});

test('Kimi: parseStream [DONE] 提前到达（无 usage）', async () => {
  const a = new KimiAdapter();
  const chunks = await collectChunks(a, 'kimi-done-early.txt');
  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const usageChunks = chunks.filter(c => c.kind === 'usage');
  const doneChunks = chunks.filter(c => c.kind === 'done');

  assert.deepEqual(textDeltas, ['简短回答']);
  assert.equal(usageChunks.length, 0, '无 usage chunk');
  assert.equal(doneChunks.length, 1);
});

test('Kimi: parseStream 空 chunk 不崩溃', async () => {
  const a = new KimiAdapter();
  const res = { body: Readable.from([Buffer.from('', 'utf8')]) };
  const chunks = [];
  for await (const c of a.parseStream(res, {})) chunks.push(c);
  assert.equal(chunks.length, 0);
});

// ========== mapError ==========

test('Kimi: mapError 401 → auth', () => {
  const a = new KimiAdapter();
  const e = a.mapError(401, JSON.stringify({ error: { message: 'Invalid token' } }));
  assert.equal(e.code, 'auth');
  assert.equal(e.retryable, false);
  assert.match(e.message, /Invalid token/);
});

test('Kimi: mapError 429 → rate (retryable)', () => {
  const a = new KimiAdapter();
  const e = a.mapError(429, JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
  assert.equal(e.code, 'rate');
  assert.equal(e.retryable, true);
});

test('Kimi: mapError 400 → badreq', () => {
  const a = new KimiAdapter();
  const e = a.mapError(400, JSON.stringify({ error: { message: 'Bad request' } }));
  assert.equal(e.code, 'badreq');
});

test('Kimi: mapError 500 → upstream (retryable)', () => {
  const a = new KimiAdapter();
  const e = a.mapError(500, 'Internal Server Error');
  assert.equal(e.code, 'upstream');
  assert.equal(e.retryable, true);
});

test('Kimi: mapError 非 JSON 响应体不崩溃', () => {
  const a = new KimiAdapter();
  const e = a.mapError(502, 'Bad Gateway');
  assert.equal(e.code, 'upstream');
});

// ========== extractUsage ==========

test('Kimi: extractUsage 从完整响应提取', () => {
  const a = new KimiAdapter();
  const payload = {
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
  const u = a.extractUsage(payload);
  assert.equal(u.promptTokens, 20);
  assert.equal(u.completionTokens, 10);
  assert.equal(u.totalTokens, 30);
  assert.equal(u.usageSource, 'upstream');
});

test('Kimi: extractUsage 无 usage 返回 null', () => {
  const a = new KimiAdapter();
  assert.equal(a.extractUsage({}), null);
  assert.equal(a.extractUsage(null), null);
});
