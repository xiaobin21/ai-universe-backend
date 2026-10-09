'use strict';

/**
 * 智谱 GLM 适配器单元测试（契约 §17）。
 * 不触网：用 Readable.from 构造 {body} 替代真实 HTTP 响应。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { ZhipuAdapter } = require('../../src/adapters/zhipu');
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

test('Zhipu: capabilitiesFor glm-4-plus 有 tools/struct，无 vision', () => {
  const a = new ZhipuAdapter();
  const cap = a.capabilitiesFor('glm-4-plus');
  assert.equal(cap.supportsStreaming, true);
  assert.equal(cap.supportsTools, true);
  assert.equal(cap.supportsStructuredOutput, true);
  assert.equal(cap.supportsVision, false);
  assert.equal(cap.supportsSystemPrompt, true);
  assert.equal(cap.contextWindow, 128000);
  assert.equal(cap.maxOutputTokens, 4096);
  assert.equal(cap.toolCallFormat, 'openai');
  assert.deepEqual(cap.inputModalities, ['text']);
});

test('Zhipu: capabilitiesFor glm-4v-plus 有 vision，无 tools/struct', () => {
  const a = new ZhipuAdapter();
  const cap = a.capabilitiesFor('glm-4v-plus');
  assert.equal(cap.supportsVision, true);
  assert.equal(cap.supportsTools, false);
  assert.equal(cap.supportsStructuredOutput, false);
  assert.equal(cap.contextWindow, 8192);
  assert.deepEqual(cap.inputModalities, ['text', 'image']);
  assert.deepEqual(cap.imageInputFormats, ['url']);
});

test('Zhipu: capabilitiesFor glm-4-flash 与 glm-4-plus 能力一致', () => {
  const a = new ZhipuAdapter();
  const plus = a.capabilitiesFor('glm-4-plus');
  const flash = a.capabilitiesFor('glm-4-flash');
  assert.equal(flash.supportsTools, plus.supportsTools);
  assert.equal(flash.supportsStructuredOutput, plus.supportsStructuredOutput);
  assert.equal(flash.contextWindow, plus.contextWindow);
});

test('Zhipu: capabilitiesFor 未知模型走兜底', () => {
  const a = new ZhipuAdapter();
  const cap = a.capabilitiesFor('unknown-glm');
  assert.equal(cap.contextWindow, 128000);
  assert.equal(cap.supportsVision, false);
});

// ========== buildRequest ==========

test('Zhipu: buildRequest 生成正确 url/headers/body', () => {
  const a = new ZhipuAdapter();
  const req = {
    model: { id: 'glm-plus', provider: 'zhipu', providerModel: 'glm-4-plus' },
    apiKey: 'glm-test-key-abcdef',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are GLM.' }] },
      { role: 'user', parts: [{ type: 'text', text: '你好' }] },
    ],
    maxOutputTokens: 2048,
    temperature: 0.5,
  };
  const { url, headers, body } = a.buildRequest(req);
  assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer glm-test-key-abcdef');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'glm-4-plus');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, '你好');
});

test('Zhipu: buildRequest 带图片时 content 为数组格式', () => {
  const a = new ZhipuAdapter();
  const req = {
    model: { providerModel: 'glm-4v-plus' },
    apiKey: 'glm-test',
    messages: [
      { role: 'user', parts: [
        { type: 'text', text: '这是什么' },
        { type: 'image', url: 'https://example.com/cat.png' },
      ]},
    ],
    maxOutputTokens: 1024,
  };
  const { body } = a.buildRequest(req);
  const userMsg = body.messages[0];
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content[0].type, 'text');
  assert.equal(userMsg.content[1].type, 'image_url');
  assert.equal(userMsg.content[1].image_url.url, 'https://example.com/cat.png');
});

test('Zhipu: buildRequest 无 baseUrl 时用默认', () => {
  const a = new ZhipuAdapter();
  const req = {
    model: { providerModel: 'glm-4-flash' },
    apiKey: 'glm-test',
    messages: [],
    maxOutputTokens: 1024,
  };
  const { url } = a.buildRequest(req);
  assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
});

// ========== parseStream ==========

test('Zhipu: parseStream 正常流解析 textDelta + reasoningDelta + usage + done', async () => {
  const a = new ZhipuAdapter();
  const chunks = await collectChunks(a, 'zhipu-normal.txt');

  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const reasoningDeltas = chunks.filter(c => c.kind === 'reasoningDelta').map(c => c.text);
  const usageChunks = chunks.filter(c => c.kind === 'usage');
  const doneChunks = chunks.filter(c => c.kind === 'done');

  assert.deepEqual(textDeltas, ['好的，', '我来详细解释一下。']);
  assert.deepEqual(reasoningDeltas, ['分析用户意图：用户想了解这个概念', '需要从多个角度解释']);
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.promptTokens, 20);
  assert.equal(usageChunks[0].usage.completionTokens, 15);
  assert.equal(usageChunks[0].usage.totalTokens, 35);
  assert.equal(usageChunks[0].usage.usageSource, 'upstream');
  assert.equal(doneChunks.length, 1);
});

test('Zhipu: parseStream 中途错误事件产出 error chunk', async () => {
  const a = new ZhipuAdapter();
  const chunks = await collectChunks(a, 'zhipu-error-midstream.txt');
  const errChunks = chunks.filter(c => c.kind === 'error');
  assert.equal(errChunks.length, 1);
  assert.ok(errChunks[0].error instanceof AppError);
  assert.match(errChunks[0].error.message, /Invalid API key/);
});

test('Zhipu: parseStream flash 模型正常流无 reasoning', async () => {
  const a = new ZhipuAdapter();
  const chunks = await collectChunks(a, 'zhipu-flash-normal.txt');
  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  const reasoningDeltas = chunks.filter(c => c.kind === 'reasoningDelta');
  assert.deepEqual(textDeltas, ['这是一个简单的', '回答。']);
  assert.equal(reasoningDeltas.length, 0, 'flash 无 reasoning');
  const usage = chunks.find(c => c.kind === 'usage');
  assert.equal(usage.usage.promptTokens, 8);
  assert.equal(usage.usage.completionTokens, 6);
});

test('Zhipu: parseStream 4v 模型正常流', async () => {
  const a = new ZhipuAdapter();
  const chunks = await collectChunks(a, 'zhipu-v-normal.txt');
  const textDeltas = chunks.filter(c => c.kind === 'textDelta').map(c => c.text);
  assert.deepEqual(textDeltas, ['图片中可以看到', '一只猫在窗边']);
  const usage = chunks.find(c => c.kind === 'usage');
  assert.equal(usage.usage.promptTokens, 300);
});

test('Zhipu: parseStream 空 chunk 不崩溃', async () => {
  const a = new ZhipuAdapter();
  const res = { body: Readable.from([Buffer.from('', 'utf8')]) };
  const chunks = [];
  for await (const c of a.parseStream(res, {})) chunks.push(c);
  assert.equal(chunks.length, 0);
});

// ========== mapError ==========

test('Zhipu: mapError 401 → auth', () => {
  const a = new ZhipuAdapter();
  const e = a.mapError(401, JSON.stringify({ error: { message: 'Invalid API key provided.' } }));
  assert.equal(e.code, 'auth');
  assert.equal(e.retryable, false);
  assert.match(e.message, /Invalid API key/);
});

test('Zhipu: mapError 429 → rate (retryable)', () => {
  const a = new ZhipuAdapter();
  const e = a.mapError(429, JSON.stringify({ error: { message: 'Too many requests' } }));
  assert.equal(e.code, 'rate');
  assert.equal(e.retryable, true);
});

test('Zhipu: mapError 400 → badreq', () => {
  const a = new ZhipuAdapter();
  const e = a.mapError(400, JSON.stringify({ error: { message: 'Bad request' } }));
  assert.equal(e.code, 'badreq');
});

test('Zhipu: mapError 503 → upstream (retryable)', () => {
  const a = new ZhipuAdapter();
  const e = a.mapError(503, 'Service unavailable');
  assert.equal(e.code, 'upstream');
  assert.equal(e.retryable, true);
});

test('Zhipu: mapError 非 JSON 响应体不崩溃', () => {
  const a = new ZhipuAdapter();
  const e = a.mapError(502, 'Bad Gateway');
  assert.equal(e.code, 'upstream');
});

// ========== extractUsage ==========

test('Zhipu: extractUsage 从完整响应提取', () => {
  const a = new ZhipuAdapter();
  const payload = {
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
  const u = a.extractUsage(payload);
  assert.equal(u.promptTokens, 50);
  assert.equal(u.completionTokens, 30);
  assert.equal(u.totalTokens, 80);
  assert.equal(u.usageSource, 'upstream');
});

test('Zhipu: extractUsage 无 usage 返回 null', () => {
  const a = new ZhipuAdapter();
  assert.equal(a.extractUsage({}), null);
  assert.equal(a.extractUsage(null), null);
});
