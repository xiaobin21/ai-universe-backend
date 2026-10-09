'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { DeepseekAdapter } = require('../../src/adapters/deepseek');
const { AppError } = require('../../src/core/errors');

const adapter = new DeepseekAdapter();
const SAMPLES = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');

function readSample(name) {
  return fs.readFileSync(path.join(SAMPLES, name), 'utf8');
}

async function collectStream(name, ctx = {}) {
  const body = Readable.from([Buffer.from(readSample(name), 'utf8')]);
  const chunks = [];
  for await (const c of adapter.parseStream({ body }, ctx)) chunks.push(c);
  return chunks;
}

// ---------- capabilitiesFor（按 providerModel 区分） ----------

test('capabilitiesFor：deepseek-reasoner 有思考链、无 structured、无视觉', () => {
  const c = adapter.capabilitiesFor('deepseek-reasoner');
  assert.equal(c.supportsThinking, true);
  assert.equal(c.supportsStructuredOutput, false);
  assert.equal(c.supportsTools, true);
  assert.equal(c.supportsVision, false);
  assert.equal(c.contextWindow, 65536);
  assert.deepEqual(c.imageInputFormats, []);
  assert.equal(c.toolCallFormat, 'openai');
});

test('capabilitiesFor：deepseek-chat 无思考链、有 structured', () => {
  const c = adapter.capabilitiesFor('deepseek-chat');
  assert.equal(c.supportsThinking, false);
  assert.equal(c.supportsStructuredOutput, true);
  assert.equal(c.supportsTools, true);
});

// ---------- buildRequest ----------

function makeReq(over = {}) {
  return Object.assign({
    apiKey: 'sk-ds-test',
    model: { id: 'deepseek-chat', provider: 'deepseek', providerModel: 'deepseek-chat' },
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'sys' }] },
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
    maxOutputTokens: 2048,
    temperature: 0.5,
  }, over);
}

test('buildRequest：默认 base + /chat/completions + Bearer', () => {
  const r = adapter.buildRequest(makeReq());
  assert.equal(r.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(r.headers.Authorization, 'Bearer sk-ds-test');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.stream_options.include_usage, true);
  assert.equal(r.body.max_tokens, 2048);
});

test('buildRequest：deepseek-chat 透传 temperature', () => {
  const r = adapter.buildRequest(makeReq());
  assert.equal(r.body.temperature, 0.5);
});

test('buildRequest：deepseek-reasoner 即使传入 temperature 也不透传', () => {
  const r = adapter.buildRequest(makeReq({
    model: { id: 'deepseek-r1', provider: 'deepseek', providerModel: 'deepseek-reasoner' },
  }));
  assert.equal(r.body.temperature, undefined);
});

test('buildRequest：无 apiKey 抛 nokey', () => {
  assert.throws(() => adapter.buildRequest(makeReq({ apiKey: '' })), (e) => {
    assert.equal(e.code, 'nokey');
    return true;
  });
});

// ---------- parseStream ----------

test('parseStream：reasoner 思考链独立 reasoningDelta；识别 prompt_cache_hit/miss', async () => {
  const chunks = await collectStream('deepseek-reasoner.txt');
  const reasoning = chunks.filter((c) => c.kind === 'reasoningDelta').map((c) => c.text);
  assert.deepEqual(reasoning, ['用户问 2+2。先拆解...', '2 加 2 等于 4。']);

  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text);
  assert.deepEqual(texts, ['2+2=4']);

  const u = chunks.find((c) => c.kind === 'usage').usage;
  assert.equal(u.promptTokens, 18);
  assert.equal(u.completionTokens, 9);
  assert.equal(u.cachedTokens, 5);
  assert.equal(u.cacheMissTokens, 13);
});

test('parseStream：chat 模型无 reasoningDelta，只有 textDelta', async () => {
  const chunks = await collectStream('deepseek-chat.txt');
  assert.equal(chunks.find((c) => c.kind === 'reasoningDelta'), undefined);
  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text);
  assert.deepEqual(texts, ['DeepSeek Chat V3 回复。']);

  const u = chunks.find((c) => c.kind === 'usage').usage;
  assert.equal(u.promptTokens, 7);
  assert.equal(u.completionTokens, 6);
});

test('parseStream：流中错误 -> AppError 并中断', async () => {
  const errBody = 'data: {"error":{"message":"Insufficient Balance","type":"invalid_request_error","code":"invalid_request"}}\n\n';
  const body = Readable.from([Buffer.from(errBody, 'utf8')]);
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _c of adapter.parseStream({ body }, {})) { /* drain */ }
  }, (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'badreq');
    return true;
  });
});

test('parseStream：无 body -> 直接 done', async () => {
  const chunks = [];
  for await (const c of adapter.parseStream({}, {})) chunks.push(c);
  assert.deepEqual(chunks, [{ kind: 'done' }]);
});

// ---------- mapError ----------

test('mapError：401 -> auth；429 -> rate(可重试)；400 提取 message', () => {
  assert.equal(adapter.mapError(401, '').code, 'auth');
  const rate = adapter.mapError(429, '');
  assert.equal(rate.code, 'rate');
  assert.equal(rate.retryable, true);

  const bad = adapter.mapError(400, JSON.stringify({ error: { message: 'reasoner 不支持 temperature', code: 'invalid_request_error' } }));
  assert.equal(bad.code, 'badreq');
  assert.equal(bad.message, 'reasoner 不支持 temperature');
});

test('mapError：余额不足 -> budget；5xx -> upstream', () => {
  const b = adapter.mapError(402, JSON.stringify({ error: { code: 'insufficient_quota' } }));
  assert.equal(b.code, 'budget');
  const u = adapter.mapError(503, '');
  assert.equal(u.code, 'upstream');
  assert.equal(u.retryable, true);
});

// ---------- extractUsage ----------

test('extractUsage：识别 prompt_cache_hit/miss_tokens', () => {
  const u = adapter.extractUsage({
    usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 13 },
  });
  assert.equal(u.promptTokens, 18);
  assert.equal(u.cachedTokens, 5);
  assert.equal(u.cacheMissTokens, 13);
  assert.equal(u.usageSource, 'upstream');
});

test('extractUsage：无 token -> null', () => {
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
});

