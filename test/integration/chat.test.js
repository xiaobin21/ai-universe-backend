'use strict';

/**
 * 聊天核心集成测试（真实 embedded PostgreSQL，不触外网、不扣费）。
 *
 * 链路：
 *  注册/登录 -> 建会话 -> POST /messages（Idempotency-Key）走 demo SSE
 *   断言 start/delta/done；刷新历史后 parts 仍在；
 *   同 Idempotency-Key 重发不产生第二个 assistant；
 *   对长 demo 取消；
 *   再用本地 http SSE mock + 注入 safeFetch 走「真实供应商」路径，断言 usage 与整数 cost。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

const { startTestPg } = require('../helpers/embedded-pg');

// 测试环境（必须在 require 业务模块之前）
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY_ID = process.env.ENCRYPTION_KEY_ID || 'k1';
if (!process.env.MASTER_ENCRYPTION_KEY) {
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '100000';

const { createApp } = require('../../src/app');
const { endPool, query } = require('../../src/db/pool');
const { encryptSecret } = require('../../src/core/security/crypto');
const { createChatService } = require('../../src/core/chat/chat.service');
const { fetch: ufetch } = require('undici');

let pg;
let server;
let base;

async function req(path, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Buffer)) h['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json, text, res };
}

/** 读取 SSE 响应流，收集 {type,data}。 */
async function consumeSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let eventType = 'message';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith('event:')) { eventType = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      let data;
      try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
      events.push({ type: eventType, data });
      if (['done', 'error', 'cancelled'].includes(eventType)) return events;
    }
  }
  return events;
}

test.before(async () => {
  pg = await startTestPg({ seed: true });
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await endPool().catch(() => {});
  if (pg) await pg.stop();
});

const EMAIL = `chat_${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery staple';
let access = '';
let userId = '';
let demoModelId = '';

test('01 注册/登录', async () => {
  const reg = await req('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  access = reg.json.accessToken;
  userId = reg.json.user.id;
});

test('02 建会话并确认有 demo 模型', async () => {
  const cat = await req('/api/catalog', { token: access });
  assert.equal(cat.status, 200);
  assert.ok(cat.json.models.length >= 20);
  demoModelId = cat.json.models[0].id;
  const c = await req('/api/conversations', { method: 'POST', token: access, body: { title: '演示', modelId: demoModelId } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.ok(c.json.id);
});

test('03 demo 流式对话：start/delta/done 事件齐全', async () => {
  const conv = (await req('/api/conversations', { token: access })).json[0];
  const idem = crypto.randomUUID();
  const r = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '你好，做个自我介绍', attachments: [] }),
  });
  assert.equal(r.status, 200, 'SSE 应正常开启');
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = await consumeSse(r);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('start'), '应有 start');
  assert.ok(types.includes('delta'), '应有 delta');
  assert.ok(types.includes('done'), '应有 done');
  const start = events.find((e) => e.type === 'start').data;
  assert.ok(start.jobId && start.userMessageId && start.assistantMessageId);
  const done = events.find((e) => e.type === 'done').data;
  assert.equal(done.status, 'completed');
  // demo 不扣费
  assert.equal(done.costMicro, 0);
});

test('04 刷新会话历史：消息与 parts 仍在', async () => {
  const conv = (await req('/api/conversations', { token: access })).json[0];
  const d = await req(`/api/conversations/${conv.id}`, { token: access });
  assert.equal(d.status, 200);
  const userMsgs = d.json.messages.filter((m) => m.role === 'user');
  const asstMsgs = d.json.messages.filter((m) => m.role === 'assistant');
  assert.ok(userMsgs.length >= 1, '应有 user 消息');
  assert.ok(asstMsgs.length >= 1, '应有 assistant 消息');
  const asst = asstMsgs[asstMsgs.length - 1];
  assert.equal(asst.status, 'completed');
  assert.ok(asst.parts.length >= 1, 'assistant 应有 parts');
  assert.ok(asst.parts.some((p) => p.type === 'text'));
});

test('05 同 Idempotency-Key 重发不产生第二个 assistant', async () => {
  const conv = (await req('/api/conversations', { token: access })).json[0];
  const before = (await req(`/api/conversations/${conv.id}`, { token: access })).json.messages;
  const asstBefore = before.filter((m) => m.role === 'assistant').length;
  const idem = crypto.randomUUID();
  // 第一次
  const r1 = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '第一条新消息', attachments: [] }),
  });
  await consumeSse(r1);
  // 同 key 重发
  const r2 = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '第一条新消息', attachments: [] }),
  });
  const ev2 = await consumeSse(r2);
  assert.ok(ev2.length > 0, '重放应返回已有事件流');
  const after = (await req(`/api/conversations/${conv.id}`, { token: access })).json.messages;
  const asstAfter = after.filter((m) => m.role === 'assistant').length;
  assert.equal(asstAfter, asstBefore + 1, '同幂等键不得新建第二条 assistant');
});

test('06 长 demo 取消', async () => {
  const conv = (await req('/api/conversations', { token: access })).json[0];
  const idem = crypto.randomUUID();
  const r = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '请写一段很长的文章，越多越好', attachments: [] }),
  });
  // 读 start 拿 jobId
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let jobId = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:') && !jobId) {
        try { const d = JSON.parse(line.slice(5).trim()); if (d.jobId) { jobId = d.jobId; } } catch {}
      }
      if (jobId) break;
    }
    if (jobId) break;
  }
  assert.ok(jobId, '应拿到 jobId');
  // 立即取消
  const cancel = await req(`/api/chat/jobs/${jobId}/cancel`, { method: 'POST', token: access });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
  // 继续把流读完
  const rest = await (async () => {
    let b = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      b += dec.decode(value, { stream: true });
      if (/^event: (done|cancelled|error)$/m.test(b)) break;
    }
    return b;
  })();
  reader.releaseLock();
  r.body.cancel().catch(() => {});
  assert.ok(/event: (cancelled|done|error)/.test(rest), '流应以 cancelled/done/error 结束');
  // 任务最终状态
  const job = await req(`/api/chat/jobs/${jobId}`, { token: access });
  assert.ok(['cancelled', 'completed', 'failed'].includes(job.json.job.status));
});

test('07 真实供应商路径：本地 SSE mock + 注入 safeFetch，usage 与整数 cost', async () => {
  // 本地 mock OpenAI 兼容 SSE
  const mockSse = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(mockSse);
    res.end();
  });
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;

  // 测试专用 safeFetch：绕过 SSRF（仅本地 mock；生产 SSRF 已单测覆盖）
  const localSafeFetch = async (url, options = {}) => {
    const resp = await ufetch(url, {
      method: options.method || 'POST',
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
    return { status: resp.status, headers: resp.headers, body: resp.body, raw: resp };
  };

  // 直接落一条 deepseek 用户凭证（baseUrl 指向本地 mock；跳过 HTTP 路由的 SSRF 静态校验）
  const enc = encryptSecret('sk-test-local');
  await query(
    `INSERT INTO provider_credentials(id, user_id, provider_id, encrypted_credentials, masked_hint, base_url)
     VALUES($1,$2,(SELECT id FROM providers WHERE slug='deepseek'),$3,'sk-t***ocal',$4)`,
    ['crd_' + crypto.randomBytes(8).toString('hex'), userId, enc, `http://127.0.0.1:${port}/v1`]
  );

  // 建一个 deepseek 会话
  const mdl = (await query(`SELECT id FROM models WHERE slug='deepseek-chat'`)).rows[0];
  const convId = 'cvs_' + crypto.randomBytes(8).toString('hex');
  await query(`INSERT INTO conversations(id,user_id,title,model_id) VALUES($1,$2,'真实路径测试',$3)`,
    [convId, userId, mdl.id]);

  const svc = createChatService({ safeFetch: localSafeFetch });
  const captured = [];
  const emit = (type, data) => captured.push({ type, data });
  await svc.handleUserMessage({
    userId, conversationId: convId, text: 'hi', attachments: [],
    idemKey: 'idem_' + crypto.randomUUID(), signal: new AbortController().signal, emit,
  });

  const types = captured.map((e) => e.type);
  assert.ok(types.includes('start'));
  assert.ok(types.includes('delta'));
  assert.ok(types.includes('usage'));
  assert.ok(types.includes('done'));
  const done = captured.find((e) => e.type === 'done').data;
  assert.equal(done.promptTokens, 10);
  assert.equal(done.completionTokens, 5);
  // 整数 micro
  assert.equal(Number.isInteger(done.costMicro), true);
  assert.ok(done.costMicro > 0, '真实计费应 >0');

  // usage 落库（整数）
  const rec = await query(
    `SELECT prompt_tokens AS "pt", completion_tokens AS "ct", cost_micro AS "cost", usage_source AS "src"
       FROM usage_records WHERE provider='deepseek' AND user_id=$1 ORDER BY priced_at DESC LIMIT 1`,
    [userId]
  );
  assert.equal(rec.rows[0].pt, '10');
  assert.equal(rec.rows[0].ct, '5');
  assert.equal(Number.isInteger(Number(rec.rows[0].cost)), true);
  assert.equal(rec.rows[0].src, 'upstream');

  mockServer.close();
});
