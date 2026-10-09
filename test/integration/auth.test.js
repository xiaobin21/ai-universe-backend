'use strict';

/**
 * 认证 + 凭证 集成测试（真实 embedded PostgreSQL，不触外网、不扣费）。
 *
 * 链路：注册 -> 登录 -> /me -> PUT 凭证 -> GET 列表（断言不回显完整 key） ->
 *       sessions -> refresh -> logout（会话撤销） -> 再次 refresh 401 ->
 *       重新登录 -> DELETE 凭证 -> 列表 configured=false。
 * 另覆盖：错误密码 5 次锁定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { startTestPg } = require('../helpers/embedded-pg');

// 测试专用环境（必须在 require 业务模块之前设置，尽管多数读取是惰性的）
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY_ID = process.env.ENCRYPTION_KEY_ID || 'k1';
if (!process.env.MASTER_ENCRYPTION_KEY) {
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}
// 测试期放宽登录限流（真实锁定逻辑由 DB 层单独测）
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '100000';

const { AppError } = require('../../src/core/errors');
const buildAuthRouter = require('../../src/routes/auth.routes');
const buildCredentialsRouter = require('../../src/routes/credentials.routes');
const { endPool } = require('../../src/db/pool');

let pg;
let server;
let base;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', buildAuthRouter());
  app.use('/api/credentials', buildCredentialsRouter());
  // 统一错误 JSON（契约 §7）
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error('[unexpected]', err);
    res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
  });
  return app;
}

function extractCookie(headers, name) {
  const sc = headers.get('set-cookie') || '';
  const re = new RegExp(name + '=([^;]+)');
  const m = sc.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

async function req(path, { method = 'GET', token, cookie, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `au_refresh=${cookie}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json, text, headers: res.headers };
}

test.before(async () => {
  pg = await startTestPg({ seed: true });
  await new Promise((resolve) => {
    server = makeApp().listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await endPool().catch(() => {});
  if (pg) await pg.stop();
});

const EMAIL = `user_${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery'; // >=8
const API_KEY = 'sk-live-super-secret-key-1234567890abcdef';

test('注册 -> /me -> 写凭证 -> 列表不回完整 key -> refresh -> logout', async () => {
  // 1) 注册
  const reg = await req('/api/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.ok(reg.json.accessToken);
  assert.ok(reg.json.user.id);
  assert.equal(reg.json.user.email, EMAIL);
  const refresh = extractCookie(reg.headers, 'au_refresh');
  assert.ok(refresh, '注册响应应下发 au_refresh cookie');
  let access = reg.json.accessToken;
  const userId = reg.json.user.id;

  // 2) /me
  const me = await req('/api/auth/me', { token: access });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, userId);
  assert.equal(me.json.user.email, EMAIL);

  // 3) PUT 凭证
  const put = await req(`/api/credentials/openai`, {
    method: 'PUT', token: access,
    body: { apiKey: API_KEY },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.provider, 'openai');
  assert.equal(put.json.maskedHint, 'sk-l***cdef');
  assert.equal(put.json.apiKey, undefined, 'PUT 响应不得回完整 key');

  // 4) GET 凭证列表：只出现前4后4，完整 key 绝不能出现在任何响应体
  const list = await req('/api/credentials', { token: access });
  assert.equal(list.status, 200);
  const openai = list.json.credentials.find((c) => c.provider === 'openai');
  assert.ok(openai);
  assert.equal(openai.configured, true);
  assert.equal(openai.maskedHint, 'sk-l***cdef');
  assert.ok(!list.text.includes(API_KEY), '完整 API Key 不得出现在响应体');

  // 5) sessions
  const sess = await req('/api/auth/sessions', { token: access, cookie: refresh });
  assert.equal(sess.status, 200);
  assert.ok(sess.json.sessions.length >= 1);
  assert.ok(sess.json.sessions.some((s) => s.current === true));

  // 6) refresh 换 access
  const rf = await req('/api/auth/refresh', { method: 'POST', cookie: refresh });
  assert.equal(rf.status, 200, JSON.stringify(rf.json));
  assert.ok(rf.json.accessToken, 'refresh 应签发新 access token');
  access = rf.json.accessToken;

  // 7) logout 撤销当前会话
  const lo = await req('/api/auth/logout', { method: 'POST', token: access, cookie: refresh });
  assert.equal(lo.status, 204);

  // 8) 用已撤销的 refresh 再换 -> 401
  const rf2 = await req('/api/auth/refresh', { method: 'POST', cookie: refresh });
  assert.equal(rf2.status, 401);
  assert.equal(rf2.json.error.code, 'auth');

  // 9) 重新登录
  const login = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const refresh2 = extractCookie(login.headers, 'au_refresh');
  assert.ok(refresh2);
  access = login.json.accessToken;

  // 10) 未配置供应商 test -> nokey（不触外网）
  const t1 = await req('/api/credentials/deepseek/test', { method: 'POST', token: access });
  assert.equal(t1.status, 200);
  assert.equal(t1.json.ok, false);
  assert.equal(t1.json.code, 'nokey');

  // 11) DELETE 凭证
  const del = await req('/api/credentials/openai', { method: 'DELETE', token: access });
  assert.equal(del.status, 204);
  const list2 = await req('/api/credentials', { token: access });
  const openai2 = list2.json.credentials.find((c) => c.provider === 'openai');
  assert.equal(openai2.configured, false);
  assert.equal(openai2.maskedHint, null);
});

test('未带 token 访问受保护路由 -> 401', async () => {
  const me = await req('/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.json.error.code, 'auth');
});

test('错误密码 5 次后账户锁定', async () => {
  const email = `lock_${Date.now()}@example.com`;
  await req('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD } });
  for (let i = 0; i < 5; i++) {
    const r = await req('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password-xyz' } });
    assert.equal(r.status, 401, `第 ${i + 1} 次错误密码`);
  }
  // 第 6 次即使密码正确也因锁定被拒
  const locked = await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(locked.status, 429, JSON.stringify(locked.json));
  assert.equal(locked.json.error.code, 'rate');
});
