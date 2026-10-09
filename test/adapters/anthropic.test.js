'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { AnthropicAdapter } = require('../../src/adapters/anthropic');
const { AppError } = require('../../src/core/errors');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'adapters', 'samples');
const read = (name) => fs.readFileSync(path.join(SAMPLES, name), 'utf8');

const adapter = new AnthropicAdapter();

function baseReq(over = {}) {
  return {
    model: { id: 'claude-sonnet', provider: 'anthropic', providerModel: 'claude-sonnet-4-5-20250929' },
    apiKey: 'sk-ant-test-abcdef1234567890',
    baseUrl: 'https://api.anthropic.com',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: '你是严谨的数学助手。' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: '看图说话' },
          { type: 'image', mediaType: 'image/png', dataBase64: 'aGVsbG89' },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: '好的' },
          { type: 'tool_call', toolCallId: 'tc_1', name: 'search', args: { q: 'x' } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'tc_1', content: '结果', isError: false }] },
    ],
    maxOutputTokens: 1024,
    temperature: 0.7,
    tools: [{ name: 'search', description: '查询', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    ...over,
  };
}

async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

// ---------- buildRequest 请求转换 ----------

test('buildRequest：端点 /v1/messages + 鉴权头 + 版本头', () => {
  const r = adapter.buildRequest(baseReq());
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-ant-test-abcdef1234567890');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body.model, 'claude-sonnet-4-5-20250929');
  assert.equal(r.body.max_tokens, 1024);
  assert.equal(r.body.stream, true);
  assert.equal(r.body.temperature, 0.7);
});

test('buildRequest：system 必须顶层字段，禁止塞进 messages', () => {
  const r = adapter.buildRequest(baseReq());
  assert.equal(r.body.system, '你是严谨的数学助手。');
  assert.ok(Array.isArray(r.body.messages));
  assert.ok(!r.body.messages.some((m) => m.role === 'system'), 'messages 内不得出现 system 角色');
});

test('buildRequest：图片为 base64 source，工具为 tool_use/tool_result block', () => {
  const r = adapter.buildRequest(baseReq());
  const msgs = r.body.messages;

  const userMsg = msgs.find((m) => m.role === 'user');
  const imgBlock = userMsg.content.find((b) => b.type === 'image');
  assert.ok(imgBlock, '应有 image block');
  assert.equal(imgBlock.source.type, 'base64');
  assert.equal(imgBlock.source.media_type, 'image/png');
  assert.equal(imgBlock.source.data, 'aGVsbG89');

  const asstMsg = msgs.find((m) => m.role === 'assistant');
  const toolUse = asstMsg.content.find((b) => b.type === 'tool_use');
  assert.ok(toolUse, 'assistant 应有 tool_use block');
  assert.equal(toolUse.id, 'tc_1');
  assert.equal(toolUse.name, 'search');
  assert.deepEqual(toolUse.input, { q: 'x' });

  // tool 角色结果 -> user 轮的 tool_result block
  const toolResultMsg = msgs.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(toolResultMsg, 'tool_result 应落在 user 轮');
  const tr = toolResultMsg.content.find((b) => b.type === 'tool_result');
  assert.equal(tr.tool_use_id, 'tc_1');
  assert.equal(tr.content, '结果');
});

test('buildRequest：tools 转换为 input_schema', () => {
  const r = adapter.buildRequest(baseReq());
  assert.ok(Array.isArray(r.body.tools));
  assert.equal(r.body.tools[0].name, 'search');
  assert.ok(r.body.tools[0].input_schema);
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

test('parseStream：正常 chunk -> 文本/思考/用量/done 顺序', async () => {
  const body = Readable.from([Buffer.from(read('anthropic-success.txt'))]);
  const chunks = await collect(adapter.parseStream({ body }, {}));

  const kinds = chunks.map((c) => c.kind);
  // 思考链在最前
  assert.equal(kinds.indexOf('reasoningDelta'), 0);
  const reasoning = chunks.find((c) => c.kind === 'reasoningDelta');
  assert.ok(reasoning.text.includes('拆解已知条件'));

  // 正文增量
  const texts = chunks.filter((c) => c.kind === 'textDelta').map((c) => c.text).join('');
  assert.equal(texts, '你好，我来解答。');

  // 思考链未拼进正文
  assert.ok(!texts.includes('拆解已知条件'));

  // 用量
  const usage = chunks.find((c) => c.kind === 'usage');
  assert.ok(usage, '应有 usage chunk');
  assert.equal(usage.usage.promptTokens, 25);
  assert.equal(usage.usage.completionTokens, 12);
  assert.equal(usage.usage.totalTokens, 37);
  assert.equal(usage.usage.usageSource, 'upstream');

  // done 在最后
  assert.equal(kinds[kinds.length - 1], 'done');
});

test('parseStream：中途错误事件 -> 终止于 error chunk', async () => {
  const body = Readable.from([Buffer.from(read('anthropic-error.txt'))]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  const errChunk = chunks[chunks.length - 1];
  assert.equal(errChunk.kind, 'error');
  assert.ok(errChunk.error instanceof AppError);
  // overloaded_error -> upstream 可重试
  assert.equal(errChunk.error.code, 'upstream');
  assert.equal(errChunk.error.retryable, true);
  // 错误之后不再产生正文
  assert.ok(!chunks.slice(0, -1).some((c) => c.kind === 'done'));
});

test('parseStream：提前结束（无 message_stop）-> 不产生 done', async () => {
  const partial = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n';
  const body = Readable.from([Buffer.from(partial)]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  assert.equal(chunks[0].kind, 'textDelta');
  assert.equal(chunks[0].text, '半截');
  assert.ok(!chunks.some((c) => c.kind === 'done'), '提前结束不应有 done');
  assert.ok(!chunks.some((c) => c.kind === 'error'));
});

test('parseStream：连接中断（流报错）-> error chunk', async () => {
  const s = new Readable({ read() {} });
  s.push(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'));
  s.destroy(new Error('socket hang up'));
  const chunks = await collect(adapter.parseStream({ body: s }, {}));
  const last = chunks[chunks.length - 1];
  assert.equal(last.kind, 'error');
  assert.ok(last.error instanceof AppError);
  assert.equal(last.error.code, 'network');
});

test('parseStream：空 chunk / 空白行 -> 不抛错', async () => {
  const body = Readable.from([Buffer.from(''), Buffer.from('\n\n'), Buffer.from('   \n\n')]);
  const chunks = await collect(adapter.parseStream({ body }, {}));
  assert.ok(Array.isArray(chunks));
  assert.ok(!chunks.some((c) => c.kind === 'error'));
});

test('parseStream：缺 body 抛 upstream', async () => {
  await assert.rejects(() => collect(adapter.parseStream({}, {})), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'upstream');
    return true;
  });
});

// ---------- mapError ----------

test('mapError：401 -> auth 不可重试', () => {
  const e = adapter.mapError(401, JSON.stringify({ error: { message: 'bad key' } }), null);
  assert.equal(e.code, 'auth');
  assert.equal(e.retryable, false);
  assert.ok(e.message.includes('bad key'));
});

test('mapError：429 -> rate 可重试', () => {
  const e = adapter.mapError(429, '', null);
  assert.equal(e.code, 'rate');
  assert.equal(e.retryable, true);
});

test('mapError：5xx -> upstream 可重试', () => {
  for (const s of [500, 502, 503]) {
    const e = adapter.mapError(s, '', null);
    assert.equal(e.code, 'upstream');
    assert.equal(e.retryable, true);
  }
});

test('mapError：529 overloaded -> upstream 可重试', () => {
  const e = adapter.mapError(529, JSON.stringify({ error: { type: 'overloaded_error', message: 'over' } }), null);
  assert.equal(e.code, 'upstream');
  assert.equal(e.retryable, true);
});

// ---------- extractUsage ----------

test('extractUsage：非流式载荷正确提取', () => {
  const u = adapter.extractUsage({ usage: { input_tokens: 11, output_tokens: 7 } });
  assert.deepEqual(u, { promptTokens: 11, completionTokens: 7, totalTokens: 18, usageSource: 'upstream' });
});

test('extractUsage：无 usage 返回 null', () => {
  assert.equal(adapter.extractUsage({}), null);
  assert.equal(adapter.extractUsage(null), null);
});

// ---------- capabilitiesFor ----------

test('capabilitiesFor：声明 anthropic 工具格式与 base64 图片', () => {
  const cap = adapter.capabilitiesFor('claude-opus-4-20250514');
  assert.equal(cap.toolCallFormat, 'anthropic');
  assert.deepEqual(cap.imageInputFormats, ['base64']);
  assert.equal(cap.supportsSystemPrompt, true);
  assert.equal(cap.supportsThinking, true);
  // Haiku 不支持 thinking
  const haiku = adapter.capabilitiesFor('claude-3-5-haiku-latest');
  assert.equal(haiku.supportsThinking, false);
});
