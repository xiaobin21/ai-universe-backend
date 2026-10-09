'use strict';

/**
 * listModels 解析与优雅降级单测（契约 §2，全部 mock 上游，不触网）。
 * 覆盖：OpenAI data[].id 解析（含去重/空 data）、Gemini models[].name 去前缀、
 *       anthropic 不支持、404/405/401/网络 优雅降级、无凭证 no_credential。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { OpenAIAdapter } = require('../../src/adapters/openai');
const { DeepseekAdapter } = require('../../src/adapters/deepseek');
const { GeminiAdapter } = require('../../src/adapters/gemini');
const { AnthropicAdapter } = require('../../src/adapters/anthropic');
const { CustomOpenAICompatibleAdapter } = require('../../src/adapters/custom_openai_compatible');

/**
 * 构造一个 mock transport：返回给定 status 与 JSON/文本体。
 * 镜像 safeFetch 的 {status, raw:{text()}} 形态。
 */
function mockTransport(payload, status = 200, { throws = null } = {}) {
  return async function fakeFetch() {
    if (throws) throw throws;
    return {
      status,
      raw: { text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) },
    };
  };
}

// ---------- OpenAI 兼容解析 ----------

test('OpenAI listModels：解析 data[].id，去空白去重', async () => {
  const a = new OpenAIAdapter();
  const res = await a.listModels({
    apiKey: 'sk-x',
    transport: mockTransport({ data: [{ id: ' gpt-4o ' }, { id: 'gpt-4o' }, { id: 'gpt-4.1' }, { notId: 123 }] }),
  });
  assert.equal(res.supported, true);
  assert.deepEqual(res.models, ['gpt-4o', 'gpt-4.1']);
});

test('OpenAI listModels：空 data / 坏 JSON 仍 supported=true 且 models=[]', async () => {
  const a = new OpenAIAdapter();
  const empty = await a.listModels({ apiKey: 'k', transport: mockTransport({ data: [] }) });
  assert.deepEqual(empty.models, []);
  const badJson = await a.listModels({ apiKey: 'k', transport: mockTransport('not-json{{', 200) });
  assert.equal(badJson.supported, true);
  assert.deepEqual(badJson.models, []);
});

test('OpenAI listModels：默认 base 为官方 v1 端点', async () => {
  const a = new OpenAIAdapter();
  let seenUrl = null;
  const t = async (url) => { seenUrl = url; return { status: 200, raw: { text: async () => '{"data":[]}' } }; };
  await a.listModels({ apiKey: 'k', transport: t });
  assert.equal(seenUrl, 'https://api.openai.com/v1/models');
});

test('DeepSeek/Custom 复用 OpenAI 兼容解析', async () => {
  const d = new DeepseekAdapter();
  const dr = await d.listModels({ apiKey: 'k', transport: mockTransport({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) });
  assert.deepEqual(dr.models, ['deepseek-chat', 'deepseek-reasoner']);

  const c = new CustomOpenAICompatibleAdapter({ baseUrl: 'https://llm.example.com/v1/', apiKey: 'k' });
  let seenUrl = null;
  const t = async (url) => { seenUrl = url; return { status: 200, raw: { text: async () => '{"data":[]}' } }; };
  await c.listModels({ transport: t });
  assert.equal(seenUrl, 'https://llm.example.com/v1/models');
});

// ---------- Gemini 解析 ----------

test('Gemini listModels：解析 models[].name 并去掉 models/ 前缀', async () => {
  const g = new GeminiAdapter();
  const res = await g.listModels({
    apiKey: 'k',
    transport: mockTransport({ models: [{ name: 'models/gemini-1.5-pro' }, { name: 'models/gemini-2.0-flash' }, { name: 'gemini-raw' }] }),
  });
  assert.equal(res.supported, true);
  assert.deepEqual(res.models, ['gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-raw']);
});

test('Gemini listModels：无 models 字段 -> 空数组', async () => {
  const g = new GeminiAdapter();
  const res = await g.listModels({ apiKey: 'k', transport: mockTransport({}) });
  assert.deepEqual(res.models, []);
});

// ---------- Anthropic 不支持 ----------

test('Anthropic listModels：恒 unsupported（保留种子目录）', async () => {
  const a = new AnthropicAdapter();
  const res = await a.listModels({ apiKey: 'sk-ant' });
  assert.equal(res.supported, false);
  assert.equal(res.reason, 'unsupported');
});

// ---------- 优雅降级 ----------

test('listModels：404 / 405 -> not_found 降级而非整体失败', async () => {
  const a = new OpenAIAdapter();
  const r404 = await a.listModels({ apiKey: 'k', transport: mockTransport('{}', 404) });
  assert.equal(r404.supported, false);
  assert.equal(r404.reason, 'not_found');
  assert.equal(r404.status, 404);
  const r405 = await a.listModels({ apiKey: 'k', transport: mockTransport('{}', 405) });
  assert.equal(r405.reason, 'not_found');
});

test('listModels：401 / 403 -> auth（等同无可用凭证，跳过）', async () => {
  const a = new OpenAIAdapter();
  const r401 = await a.listModels({ apiKey: 'bad', transport: mockTransport('{}', 401) });
  assert.equal(r401.supported, false);
  assert.equal(r401.reason, 'auth');
  const r403 = await new GeminiAdapter().listModels({ apiKey: 'bad', transport: mockTransport('{}', 403) });
  assert.equal(r403.reason, 'auth');
});

test('listModels：网络/超时错误 -> network 优雅降级，不抛错', async () => {
  const a = new OpenAIAdapter();
  const r = await a.listModels({
    apiKey: 'k',
    transport: mockTransport(null, 0, { throws: new Error('ETIMEDOUT') }),
  });
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'network');
  assert.match(r.error, /ETIMEDOUT/);
});

test('listModels：无 apiKey -> no_credential', async () => {
  const a = new OpenAIAdapter();
  const r = await a.listModels({});
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'no_credential');
});
