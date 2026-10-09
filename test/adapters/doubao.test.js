'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { DoubaoAdapter, DEFAULT_BASE_URL } = require('../../src/adapters/doubao');
const { AppError } = require('../../src/core/errors');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');

function sampleStream(name) {
  const text = fs.readFileSync(path.join(SAMPLES, name), 'utf8');
  return Readable.from([text]);
}

function makeResponse(name) {
  return { status: 200, headers: { get: () => null }, body: sampleStream(name) };
}

// ---------- capabilitiesFor ----------

test('Doubao: capabilitiesFor 返回默认能力', () => {
  const adapter = new DoubaoAdapter();
  const caps = adapter.capabilitiesFor('doubao-pro-32k');
  assert.equal(caps.supportsStreaming, true);
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsVision, false);
  assert.equal(caps.supportsSystemPrompt, true);
  assert.equal(caps.contextWindow, 32768);
  assert.equal(caps.maxOutputTokens, 4096);
  assert.equal(caps.toolCallFormat, 'openai');
});

// ---------- buildRequest ----------

test('Doubao: buildRequest 正确构造请求', () => {
  const adapter = new DoubaoAdapter();
  const req = {
    model: { provider: 'doubao', providerModel: 'doubao-pro-32k' },
    messages: [
      { role: 'system', parts: [{ type: 'text', text: '你是助手' }] },
      { role: 'user', parts: [{ type: 'text', text: '你好' }] },
    ],
    maxOutputTokens: 2048,
    apiKey: 'sk-test-doubao-12345678',
  };
  const { url, headers, body } = adapter.buildRequest(req);

  assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(headers['Authorization'], 'Bearer sk-test-doubao-12345678');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'doubao-pro-32k');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, '你是助手');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, '你好');
});

test('Doubao: buildRequest 自定义 baseUrl', () => {
  const adapter = new DoubaoAdapter();
  const req = {
    model: { provider: 'doubao', providerModel: 'doubao-lite-32k' },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    maxOutputTokens: 1024,
    apiKey: 'sk-custom',
    baseUrl: 'https://my-proxy.example.com/api/v3/',
  };
  const { url, headers } = adapter.buildRequest(req);
  assert.equal(url, 'https://my-proxy.example.com/api/v3/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-custom');
});

test('Doubao: buildRequest 缺 apiKey 抛 nokey', () => {
  const adapter = new DoubaoAdapter();
  const req = {
    model: { provider: 'doubao', providerModel: 'doubao-pro-32k' },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  };
  assert.throws(() => adapter.buildRequest(req), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'nokey');
    return true;
  });
});

test('Doubao: buildRequest 处理 tool_call / tool_result', () => {
  const adapter = new DoubaoAdapter();
  const req = {
    model: { provider: 'doubao', providerModel: 'doubao-pro-32k' },
    messages: [
      { role: 'assistant', parts: [
        { type: 'text', text: '让我查一下' },
        { type: 'tool_call', toolCallId: 'call_1', name: 'get_weather', args: { city: '北京' } },
      ]},
      { role: 'tool', parts: [
        { type: 'tool_result', toolCallId: 'call_1', content: '晴，25°C' },
      ]},
    ],
    apiKey: 'sk-test',
  };
  const { body } = adapter.buildRequest(req);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'assistant');
  assert.ok(body.messages[0].tool_calls);
  assert.equal(body.messages[0].tool_calls[0].id, 'call_1');
  assert.equal(body.messages[0].tool_calls[0].function.name, 'get_weather');
  assert.equal(body.messages[1].role, 'tool');
  assert.equal(body.messages[1].tool_call_id, 'call_1');
  assert.equal(body.messages[1].content, '晴，25°C');
});

// ---------- parseStream ----------

test('Doubao: parseStream 正常流', async () => {
  const adapter = new DoubaoAdapter();
  const resp = makeResponse('doubao-normal.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const textDeltas = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(textDeltas.length, 3);
  assert.equal(textDeltas.map(c => c.text).join(''), '你好，我是豆包，有什么可以帮你的？');
  assert.ok(chunks.some(c => c.kind === 'done'));
});

test('Doubao: parseStream 含 reasoning 字段', async () => {
  const adapter = new DoubaoAdapter();
  const resp = makeResponse('doubao-reasoning.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const reasoning = chunks.filter(c => c.kind === 'reasoningDelta');
  const text = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(reasoning.length, 2);
  assert.ok(reasoning[0].text.includes('数学题'));
  assert.equal(text.length, 2);
  assert.ok(chunks.some(c => c.kind === 'done'));
});

test('Doubao: parseStream 中途出现 error', async () => {
  const adapter = new DoubaoAdapter();
  const resp = makeResponse('doubao-error.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const textDeltas = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(textDeltas.length, 1);
  assert.equal(textDeltas[0].text, '正在处理...');

  const errChunks = chunks.filter(c => c.kind === 'error');
  assert.equal(errChunks.length, 1);
  assert.ok(errChunks[0].error instanceof AppError);
  assert.ok(errChunks[0].error.message.includes('server error') || errChunks[0].error.message.includes('服务器'));
});

test('Doubao: parseStream 含 usage', async () => {
  const adapter = new DoubaoAdapter();
  const resp = makeResponse('doubao-usage.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const usageChunks = chunks.filter(c => c.kind === 'usage');
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.promptTokens, 15);
  assert.equal(usageChunks[0].usage.completionTokens, 5);
  assert.equal(usageChunks[0].usage.totalTokens, 20);
  assert.equal(usageChunks[0].usage.usageSource, 'upstream');
});

test('Doubao: parseStream 空流（无 chunk）', async () => {
  const adapter = new DoubaoAdapter();
  const resp = { status: 200, headers: { get: () => null }, body: Readable.from([]) };
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }
  assert.ok(chunks.some(c => c.kind === 'done'));
});

test('Doubao: parseStream 无 body 流', async () => {
  const adapter = new DoubaoAdapter();
  const resp = { status: 200, headers: { get: () => null }, body: null };
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'error');
  assert.ok(chunks[0].error instanceof AppError);
});

// ---------- mapError ----------

test('Doubao: mapError 401 -> auth', () => {
  const adapter = new DoubaoAdapter();
  const err = adapter.mapError(401, JSON.stringify({ error: { message: 'Invalid key' } }));
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'auth');
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
});

test('Doubao: mapError 429 -> rate (retryable)', () => {
  const adapter = new DoubaoAdapter();
  const err = adapter.mapError(429, JSON.stringify({ error: { message: 'too many requests' } }));
  assert.equal(err.code, 'rate');
  assert.equal(err.retryable, true);
});

test('Doubao: mapError 500 -> upstream (retryable)', () => {
  const adapter = new DoubaoAdapter();
  const err = adapter.mapError(500, 'Internal Server Error');
  assert.equal(err.code, 'upstream');
  assert.equal(err.retryable, true);
});

test('Doubao: mapError 400 context length -> badreq', () => {
  const adapter = new DoubaoAdapter();
  const err = adapter.mapError(400, JSON.stringify({ error: { message: 'context length exceeded, too many tokens' } }));
  assert.equal(err.code, 'badreq');
  assert.ok(err.message.includes('上下文超长'));
});

// ---------- extractUsage ----------

test('Doubao: extractUsage 正常载荷', () => {
  const adapter = new DoubaoAdapter();
  const payload = { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
  const usage = adapter.extractUsage(payload);
  assert.equal(usage.promptTokens, 100);
  assert.equal(usage.completionTokens, 50);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.usageSource, 'upstream');
});

test('Doubao: extractUsage 无 usage 字段返回 null', () => {
  const adapter = new DoubaoAdapter();
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
  assert.equal(adapter.extractUsage({ usage: {} }), null);
});
