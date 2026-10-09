'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { OpenAIAdapter } = require('../../src/adapters/openai');
const { AppError } = require('../../src/core/errors');

const adapter = new OpenAIAdapter();
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

// ---------- capabilitiesFor ----------

test('capabilitiesFor：gpt-4o 视觉/工具/结构化，无思考', () => {
  const c = adapter.capabilitiesFor('gpt-4o');
  assert.equal(c.supportsVision, true);
  assert.equal(c.supportsTools, true);
  assert.equal(c.supportsStructuredOutput, true);
  assert.equal(c.supportsThinking, false);
  assert.equal(c.contextWindow, 128000);
  assert.deepEqual(c.imageInputFormats, ['url']);
  assert.equal(c.toolCallFormat, 'openai');
});

test('capabilitiesFor：o3-mini 有思考链、无视觉', () => {
  const c = adapter.capabilitiesFor('o3-mini');
  assert.equal(c.supportsThinking, true);
  assert.equal(c.supportsVision, false);
  assert.equal(c.contextWindow, 200000);
  assert.deepEqual(c.inputModalities, ['text']);
});

test('capabilitiesFor：gpt-4.1 大上下文、无视觉', () => {
  const c = adapter.capabilitiesFor('gpt-4.1');
  assert.equal(c.contextWindow, 1047576);
  assert.equal(c.supportsVision, false);
  assert.equal(c.supportsTools, true);
});

test('capabilitiesFor：未知模型走兜底', () => {
  const c = adapter.capabilitiesFor('some-unknown-model');
  assert.equal(c.supportsStreaming, true);
  assert.equal(c.toolCallFormat, 'openai');
});

// ---------- buildRequest ----------

function makeReq(over = {}) {
  return Object.assign({
    apiKey: 'sk-test-abcdef1234567890',
    model: { id: 'gpt-4o', provider: 'openai', providerModel: 'gpt-4o' },
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are helpful.' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Hi' },
          { type: 'image', url: 'https://cdn.example.com/x.png' },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_call', toolCallId: 'call_1', name: 'search', args: { q: 'x' } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'call_1', content: 'result-body' }] },
    ],
    maxOutputTokens: 1024,
    temperature: 0.7,
    tools: [{ type: 'function', function: { name: 'search' } }],
  }, over);
}

test('buildRequest：端点 /chat/completions，Bearer 鉴权', () => {
  const r = adapter.buildRequest(makeReq());
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.Authorization, 'Bearer sk-test-abcdef1234567890');
  assert.equal(r.headers['Content-Type'], 'application/json');
});

test('buildRequest：body 含 stream / stream_options.include_usage / max_tokens', () => {
  const r = adapter.buildRequest(makeReq());
  assert.equal(r.body.model, 'gpt-4o');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.max_tokens, 1024);
  assert.equal(r.body.stream_options.include_usage, true);
  assert.equal(r.body.temperature, 0.7);
  assert.equal(r.body.tools.length, 1);
});

test('buildRequest：system 走 messages；user 含图走 content 数组', () => {
  const r = adapter.buildRequest(makeReq());
  assert.equal(r.body.messages[0].role, 'system');
  assert.equal(r.body.messages[0].content, 'You are helpful.');

  const user = r.body.messages[1];
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'https://cdn.example.com/x.png');
});

test('buildRequest：assistant 文本 + tool_calls；tool 消息独立 role=tool', () => {
  const r = adapter.buildRequest(makeReq());
  const asst = r.body.messages[2];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content, 'Hello');
  assert.equal(asst.tool_calls[0].id, 'call_1');
  assert.equal(asst.tool_calls[0].function.name, 'search');
  assert.equal(asst.tool_calls[0].function.arguments, '{"q":"x"}');

  const tool = r.body.messages[3];
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(tool.content, 'result-body');
});

test('buildRequest：自定义 baseUrl 覆盖默认；无 apiKey 抛 nokey', () => {
  const r = adapter.buildRequest(makeReq({ baseUrl: 'https://proxy.example.com/openai/' }));
  assert.equal(r.url, 'https://proxy.example.com/openai/chat/completions');

  const noKey = makeReq({ apiKey: '' });
  assert.throws(() => adapter.buildRequest(noKey), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'nokey');
    return true;
  });
});

// ---------- parseStream ----------

test('parseStream：正常流，文本增量 + usage（含 cached_tokens）+ done', async () => {
  const chunks = await collectStream('openai-normal.txt');
  const textDeltas = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text);
  assert.deepEqual(textDeltas, ['Hello', ' world']);

  const usageChunks = chunks.filter((c) => c.kind === 'usage');
  assert.equal(usageChunks.length, 1);
  const u = usageChunks[0].usage;
  assert.equal(u.promptTokens, 12);
  assert.equal(u.completionTokens, 5);
  assert.equal(u.totalTokens, 17);
  assert.equal(u.usageSource, 'upstream');
  assert.equal(u.cachedTokens, 3);

  assert.equal(chunks[chunks.length - 1].kind, 'done');
});

test('parseStream：reasoning_content 独立 reasoningDelta；识别 reasoning_tokens', async () => {
  const chunks = await collectStream('openai-reasoning.txt');
  const reasoning = chunks.filter((c) => c.kind === 'reasoningDelta').map((c) => c.text);
  assert.deepEqual(reasoning, ['Let me reason step by step.', 'The answer is 42.']);

  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text);
  assert.deepEqual(texts, ['The result is 42.']);

  const u = chunks.find((c) => c.kind === 'usage').usage;
  assert.equal(u.reasoningTokens, 8);
});

test('parseStream：流中错误 -> badreq，错误前已产出的文本仍保留', async () => {
  const seen = [];
  await assert.rejects(async () => {
    const body = Readable.from([Buffer.from(readSample('openai-mid-error.txt'), 'utf8')]);
    for await (const c of adapter.parseStream({ body }, {})) seen.push(c);
  }, (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'badreq');
    return true;
  });
  assert.ok(seen.some((c) => c.kind === 'textDelta' && c.text === 'partial'), '错误前的 partial 应已交付');
});

test('parseStream：[DONE] 提前，无内容无 usage，仍正常 done', async () => {
  const chunks = await collectStream('openai-done-early.txt');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'done');
});

test('parseStream：心跳/坏 JSON/空 chunk 安全跳过，只取有效文本', async () => {
  const chunks = await collectStream('openai-malformed.txt');
  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text);
  assert.deepEqual(texts, ['ok', ' tail']);
  assert.equal(chunks[chunks.length - 1].kind, 'done');
});

test('parseStream：外部 signal 已 abort -> cancel', async () => {
  const ac = new AbortController();
  ac.abort();
  const body = Readable.from([Buffer.from(readSample('openai-normal.txt'), 'utf8')]);
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _c of adapter.parseStream({ body }, { signal: ac.signal })) { /* drain */ }
  }, (e) => {
    assert.equal(e.code, 'cancel');
    return true;
  });
});

test('parseStream：无 body -> 直接 done', async () => {
  const chunks = [];
  for await (const c of adapter.parseStream({}, {})) chunks.push(c);
  assert.deepEqual(chunks, [{ kind: 'done' }]);
});

// ---------- mapError ----------

test('mapError：401/403 -> auth；429 -> rate(可重试)；404 -> notfound', () => {
  assert.equal(adapter.mapError(401, '').code, 'auth');
  assert.equal(adapter.mapError(403, '').code, 'auth');
  const rate = adapter.mapError(429, '{}');
  assert.equal(rate.code, 'rate');
  assert.equal(rate.retryable, true);
  assert.equal(adapter.mapError(404, '').code, 'notfound');
});

test('mapError：400 提取上游 message；5xx -> upstream(可重试)', () => {
  const e400 = adapter.mapError(400, JSON.stringify({ error: { message: 'bad body', code: 'invalid_request' } }));
  assert.equal(e400.code, 'badreq');
  assert.equal(e400.message, 'bad body');

  const e500 = adapter.mapError(500, '');
  assert.equal(e500.code, 'upstream');
  assert.equal(e500.retryable, true);
});

test('mapError：insufficient_quota / 402 -> budget', () => {
  const e = adapter.mapError(402, JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota' } }));
  assert.equal(e.code, 'budget');
  assert.equal(e.message, 'quota');
});

// ---------- extractUsage ----------

test('extractUsage：整段 chunk 与直接 usage 对象均可', () => {
  const fromChunk = adapter.extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.deepEqual(fromChunk, { promptTokens: 1, completionTokens: 2, totalTokens: 3, usageSource: 'upstream' });

  const direct = adapter.extractUsage({ prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(direct.promptTokens, 10);
  assert.equal(direct.totalTokens, 15);
});

test('extractUsage：无 token -> null', () => {
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
  assert.equal(adapter.extractUsage({ choices: [] }), null);
});
