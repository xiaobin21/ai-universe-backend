'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { CustomOpenAICompatibleAdapter } = require('../../src/adapters/custom_openai_compatible');
const { AppError } = require('../../src/core/errors');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');

function sampleStream(name) {
  const text = fs.readFileSync(path.join(SAMPLES, name), 'utf8');
  return Readable.from([text]);
}

function makeResponse(name) {
  return { status: 200, headers: { get: () => null }, body: sampleStream(name) };
}

// ---------- 构造 ----------

test('Custom: 缺配置抛 badreq', () => {
  assert.throws(() => new CustomOpenAICompatibleAdapter(), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'badreq');
    return true;
  });
});

test('Custom: 缺 baseUrl 抛 badreq', () => {
  assert.throws(() => new CustomOpenAICompatibleAdapter({ apiKey: 'sk-x' }), /baseUrl/);
});

test('Custom: 缺 apiKey 抛 nokey', () => {
  assert.throws(() => new CustomOpenAICompatibleAdapter({ baseUrl: 'https://x.com/v1' }), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'nokey');
    return true;
  });
});

test('Custom: 构造成功', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-123',
  });
  assert.equal(adapter.provider, 'custom');
});

// ---------- capabilitiesFor ----------

test('Custom: capabilitiesFor 默认值', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const caps = adapter.capabilitiesFor('some-model');
  assert.equal(caps.supportsStreaming, true);
  assert.equal(caps.supportsSystemPrompt, true);
  assert.equal(caps.supportsTools, false);
  assert.equal(caps.supportsVision, false);
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.contextWindow, 4096);
  assert.equal(caps.maxOutputTokens, 4096);
});

test('Custom: capabilitiesFor 覆盖配置', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  });
  const caps = adapter.capabilitiesFor('some-model');
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsVision, true);
  assert.equal(caps.contextWindow, 128000);
  assert.equal(caps.maxOutputTokens, 8192);
});

test('Custom: capabilitiesFor 显式关闭 streaming', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
    capabilities: { supportsStreaming: false },
  });
  assert.equal(adapter.capabilitiesFor('m').supportsStreaming, false);
});

// ---------- buildRequest ----------

test('Custom: buildRequest 使用传入 baseUrl 和 apiKey', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://my-gateway.example.com/v1/',
    apiKey: 'sk-my-key-abc',
  });
  const req = {
    model: { provider: 'custom', providerModel: 'llama-3-70b' },
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are helpful.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ],
    maxOutputTokens: 1024,
  };
  const { url, headers, body } = adapter.buildRequest(req);

  assert.equal(url, 'https://my-gateway.example.com/v1/chat/completions');
  assert.equal(headers['Authorization'], 'Bearer sk-my-key-abc');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'llama-3-70b');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('Custom: buildRequest 不支持 tools 时不带 tools', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const req = {
    model: { provider: 'custom', providerModel: 'm' },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [{ type: 'function', function: { name: 'f' } }],
  };
  const { body } = adapter.buildRequest(req);
  assert.equal(body.tools, undefined, '不支持 tools 时不应发送 tools');
});

test('Custom: buildRequest 支持 tools 时发送', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
    capabilities: { supportsTools: true },
  });
  const tools = [{ type: 'function', function: { name: 'f' } }];
  const req = {
    model: { provider: 'custom', providerModel: 'm' },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools,
  };
  const { body } = adapter.buildRequest(req);
  assert.deepEqual(body.tools, tools);
});

test('Custom: buildRequest 处理多模态图片', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
    capabilities: { supportsVision: true },
  });
  const req = {
    model: { provider: 'custom', providerModel: 'vlm' },
    messages: [
      { role: 'user', parts: [
        { type: 'text', text: '看图' },
        { type: 'image', url: 'https://example.com/img.png' },
      ]},
    ],
  };
  const { body } = adapter.buildRequest(req);
  assert.ok(Array.isArray(body.messages[0].content));
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.messages[0].content[1].type, 'image_url');
});

// ---------- parseStream ----------

test('Custom: parseStream 正常流', async () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const resp = makeResponse('custom-normal.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const textDeltas = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas.map(c => c.text).join(''), '这是自定义模型的回复。支持标准 OpenAI 兼容格式。');

  const usage = chunks.filter(c => c.kind === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].usage.promptTokens, 10);
  assert.equal(usage[0].usage.completionTokens, 12);
  assert.equal(usage[0].usage.totalTokens, 22);

  assert.ok(chunks.some(c => c.kind === 'done'));
});

test('Custom: parseStream reasoning_content', async () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const resp = makeResponse('custom-reasoning.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const reasoning = chunks.filter(c => c.kind === 'reasoningDelta');
  assert.equal(reasoning.length, 2);
  assert.ok(reasoning[0].text.includes('step by step'));
  const text = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(text.length, 1);
  assert.equal(text[0].text, 'The answer is 42.');
});

test('Custom: parseStream 中途 error', async () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const resp = makeResponse('custom-error.txt');
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }

  const textDeltas = chunks.filter(c => c.kind === 'textDelta');
  assert.equal(textDeltas.length, 1);
  const errChunks = chunks.filter(c => c.kind === 'error');
  assert.equal(errChunks.length, 1);
  assert.ok(errChunks[0].error instanceof AppError);
});

test('Custom: parseStream 空流', async () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const resp = { status: 200, headers: { get: () => null }, body: Readable.from([]) };
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }
  assert.ok(chunks.some(c => c.kind === 'done'));
});

test('Custom: parseStream 无 body', async () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const resp = { status: 200, headers: { get: () => null }, body: null };
  const chunks = [];
  for await (const c of adapter.parseStream(resp, {})) {
    chunks.push(c);
  }
  assert.equal(chunks[0].kind, 'error');
});

// ---------- mapError ----------

test('Custom: mapError 401 -> auth', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const err = adapter.mapError(401, JSON.stringify({ error: { message: 'Unauthorized' } }));
  assert.equal(err.code, 'auth');
});

test('Custom: mapError 429 -> rate retryable', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const err = adapter.mapError(429, '');
  assert.equal(err.code, 'rate');
  assert.equal(err.retryable, true);
});

test('Custom: mapError 500 -> upstream retryable', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const err = adapter.mapError(500, '');
  assert.equal(err.code, 'upstream');
  assert.equal(err.retryable, true);
});

// ---------- extractUsage ----------

test('Custom: extractUsage 正常', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  const usage = adapter.extractUsage({ usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } });
  assert.equal(usage.promptTokens, 50);
  assert.equal(usage.completionTokens, 30);
  assert.equal(usage.totalTokens, 80);
  assert.equal(usage.usageSource, 'upstream');
});

test('Custom: extractUsage 无 usage 返回 null', () => {
  const adapter = new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://x.com/v1',
    apiKey: 'sk-x',
  });
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
});
