'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { GeminiAdapter } = require('../../src/adapters/gemini');
const { AppError } = require('../../src/core/errors');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');
const read = (name) => fs.readFileSync(path.join(SAMPLES, name), 'utf8');

const adapter = new GeminiAdapter();

function baseReq(over = {}) {
  return {
    model: { id: 'gemini-pro', provider: 'gemini', providerModel: 'gemini-2.5-pro' },
    apiKey: 'AIza-test-gemini-key-123',
    baseUrl: 'https://generativelanguage.googleapis.com',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: '你是助手。' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: '看图' },
          { type: 'image', mediaType: 'image/jpeg', dataBase64: 'aW1hZ2U9' },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: '好' },
          { type: 'tool_call', toolCallId: 'tc_1', name: 'lookup', args: { a: 1 } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'tc_1', content: '数值' }] },
    ],
    maxOutputTokens: 2048,
    temperature: 0.5,
    tools: [{ name: 'lookup', description: '查', parameters: { type: 'object' } }],
    ...over,
  };
}

async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

// ---------- buildRequest ----------

test('buildRequest：端点 streamGenerateContent?alt=sse&key=', () => {
  const r = adapter.buildRequest(baseReq());
  assert.ok(r.url.includes('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key='));
  assert.ok(r.url.includes(encodeURIComponent('AIza-test-gemini-key-123')));
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body.generationConfig.maxOutputTokens, 2048);
  assert.equal(r.body.generationConfig.temperature, 0.5);
});

test('buildRequest：system 走 systemInstruction.parts，不进 contents', () => {
  const r = adapter.buildRequest(baseReq());
  assert.ok(r.body.systemInstruction);
  assert.equal(r.body.systemInstruction.parts[0].text, '你是助手。');
  assert.ok(!r.body.contents.some((c) => c.role === 'system'));
});

test('buildRequest：role 映射 user/model/function', () => {
  const r = adapter.buildRequest(baseReq());
  const roles = r.body.contents.map((c) => c.role);
  assert.ok(roles.includes('user'));
  assert.ok(roles.includes('model'));
  assert.ok(roles.includes('function'));
});

test('buildRequest：图片 inline_data，工具 functionCall/functionResponse', () => {
  const r = adapter.buildRequest(baseReq());

  const userContent = r.body.contents.find((c) => c.role === 'user');
  const inline = userContent.parts.find((p) => p.inline_data);
  assert.ok(inline, '应有 inline_data part');
  assert.equal(inline.inline_data.mime_type, 'image/jpeg');
  assert.equal(inline.inline_data.data, 'aW1hZ2U9');

  const modelContent = r.body.contents.find((c) => c.role === 'model');
  const fc = modelContent.parts.find((p) => p.functionCall);
  assert.ok(fc, 'assistant 应有 functionCall part');
  assert.equal(fc.functionCall.name, 'lookup');
  assert.deepEqual(fc.functionCall.args, { a: 1 });

  const fnContent = r.body.contents.find((c) => c.role === 'function');
  const fr = fnContent.parts.find((p) => p.functionResponse);
  assert.ok(fr, 'tool 结果应有 functionResponse part');
  assert.equal(fr.functionResponse.name, 'tc_1');
});

test('buildRequest：tools -> functionDeclarations', () => {
  const r = adapter.buildRequest(baseReq());
  assert.ok(Array.isArray(r.body.tools));
  assert.equal(r.body.tools[0].functionDeclarations[0].name, 'lookup');
});

test('buildRequest：缺 apiKey 抛 nokey', () => {
  const req = baseReq();
  delete req.apiKey;
  assert.throws(() => adapter.buildRequest(req), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'nokey');
    return true;
  });
});

// ---------- parseStream ----------

test('parseStream：正常 chunk -> reasoning/text/usage/done', async () => {
  const body = Readable.from([Buffer.from(read('gemini-success.txt'))]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  const kinds = chunks.map((c) => c.kind);

  const reasoning = chunks.find((c) => c.kind === 'reasoningDelta');
  assert.ok(reasoning, '应有 reasoningDelta（thought part）');
  assert.ok(reasoning.text.includes('结构化回答'));

  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text).join('');
  assert.equal(texts, '你好，这是 Gemini 的回答。');

  const usageChunks = chunks.filter((c) => c.kind === 'usage');
  const usage = usageChunks[usageChunks.length - 1];
  assert.ok(usage);
  assert.equal(usage.usage.promptTokens, 10);
  assert.equal(usage.usage.completionTokens, 6);
  assert.equal(usage.usage.totalTokens, 16);
  assert.equal(usage.usage.usageSource, 'upstream');

  assert.equal(kinds[kinds.length - 1], 'done');
});

test('parseStream：中途错误 -> error chunk 终止', async () => {
  const body = Readable.from([Buffer.from(read('gemini-error.txt'))]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  const last = chunks[chunks.length - 1];
  assert.equal(last.kind, 'error');
  assert.ok(last.error instanceof AppError);
  assert.equal(last.error.code, 'rate');
  assert.equal(last.error.retryable, true);
});

test('parseStream：提前结束（无 usageMetadata）-> 无 usage，仅 done', async () => {
  const partial = 'data: {"candidates":[{"content":{"parts":[{"text":"半截"}],"role":"model"},"finishReason":"STOP"}]}\n\n';
  const body = Readable.from([Buffer.from(partial)]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  assert.equal(chunks[0].kind, 'textDelta');
  assert.equal(chunks[0].text, '半截');
  assert.ok(!chunks.some((c) => c.kind === 'usage'), '无 usageMetadata 不应产出 usage');
  assert.equal(chunks[chunks.length - 1].kind, 'done');
});

test('parseStream：连接中断（流报错）-> error chunk', async () => {
  const s = new Readable({ read() {} });
  s.push(Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"正在"}]},"role":"model"}]}\n\n'));
  s.destroy(new Error('socket hang up'));
  const chunks = await collect(adapter.parseStream({ body: s }, {}));
  const last = chunks[chunks.length - 1];
  assert.equal(last.kind, 'error');
  assert.ok(last.error instanceof AppError);
  assert.equal(last.error.code, 'network');
});

test('parseStream：空 chunk -> 仅 done 不抛错', async () => {
  const body = Readable.from([Buffer.from(''), Buffer.from('\n\n')]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  assert.ok(!chunks.some((c) => c.kind === 'error'));
  assert.equal(chunks[chunks.length - 1].kind, 'done');
});

test('parseStream：缺 body 抛 upstream', async () => {
  await assert.rejects(() => collect(adapter.parseStream({}, {})), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'upstream');
    return true;
  });
});

// ---------- mapError ----------

test('mapError：401 -> auth', () => {
  const e = adapter.mapError(401, JSON.stringify({ error: { message: 'bad' } }), null);
  assert.equal(e.code, 'auth');
  assert.equal(e.retryable, false);
});

test('mapError：429 -> rate 可重试', () => {
  const e = adapter.mapError(429, '', null);
  assert.equal(e.code, 'rate');
  assert.equal(e.retryable, true);
});

test('mapError：5xx -> upstream 可重试', () => {
  const e = adapter.mapError(500, '', null);
  assert.equal(e.code, 'upstream');
  assert.equal(e.retryable, true);
});

// ---------- extractUsage ----------

test('extractUsage：usageMetadata 提取', () => {
  const u = adapter.extractUsage({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } });
  assert.deepEqual(u, { promptTokens: 3, completionTokens: 4, totalTokens: 7, usageSource: 'upstream' });
});

test('extractUsage：无 usageMetadata 返回 null', () => {
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
});

// ---------- capabilitiesFor ----------

test('capabilitiesFor：gemini 工具格式与 base64 图片', () => {
  const cap = adapter.capabilitiesFor('gemini-2.5-pro');
  assert.equal(cap.toolCallFormat, 'gemini');
  assert.deepEqual(cap.imageInputFormats, ['base64']);
  assert.equal(cap.supportsSystemPrompt, true);
  assert.equal(cap.supportsThinking, true);
});
