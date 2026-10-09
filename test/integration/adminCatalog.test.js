'use strict';

/**
 * 管理员目录路由鉴权 + cron 签名集成测试（真实 embedded PostgreSQL）。
 * 覆盖：非管理员访问 admin catalog 一律 403；管理员 200；cron 无 CRON_SECRET -> 503。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { startTestPg } = require('../helpers/embedded-pg');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY_ID = process.env.ENCRYPTION_KEY_ID || 'k1';
if (!process.env.MASTER_ENCRYPTION_KEY) {
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '100000';
// 指定管理员邮箱名单：命中即管理员；其余注册用户非管理员
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'boss@example.com';

const { AppError } = require('../../src/core/errors');
const buildAuthRouter = require('../../src/routes/auth.routes');
const buildAdminRouter = require('../../src/routes/admin.routes');
const buildCronRouter = require('../../src/routes/cron.routes');
const { endPool } = require('../../src/db/pool');

let pg;
let server;
let base;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', buildAuthRouter());
  app.use('/api/admin', buildAdminRouter());
  app.use('/api/cron', buildCronRouter());
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
  });
  return app;
}

async function req(path, { method = 'GET', token, body, headers } = {}) {
  const h = { 'content-type': 'application/json', ...(headers || {}) };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json, text };
}

test.before(async () => {
  pg = await startTestPg({ seed: true });
  await new Promise((resolve) => { server = makeApp().listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await endPool().catch(() => {});
  if (pg) await pg.stop();
});

let adminToken;
let userToken;

test('准备：注册管理员与普通用户', async () => {
  const admin = await req('/api/auth/register', { method: 'POST', body: { email: 'boss@example.com', password: 'correct horse battery' } });
  assert.equal(admin.status, 201, JSON.stringify(admin.json));
  adminToken = admin.json.accessToken;
  const user = await req('/api/auth/register', { method: 'POST', body: { email: 'plain@example.com', password: 'correct horse battery' } });
  assert.equal(user.status, 201);
  userToken = user.json.accessToken;
});

test('非管理员访问 GET /api/admin/catalog/status -> 403', async () => {
  const res = await req('/api/admin/catalog/status', { token: userToken });
  assert.equal(res.status, 403);
});

test('非管理员 POST /api/admin/catalog/sync -> 403', async () => {
  const res = await req('/api/admin/catalog/sync', { method: 'POST', token: userToken, body: {} });
  assert.equal(res.status, 403);
});

test('未登录访问 admin -> 401', async () => {
  const res = await req('/api/admin/catalog/status');
  assert.equal(res.status, 401);
});

test('管理员访问 GET /api/admin/catalog/status -> 200', async () => {
  const res = await req('/api/admin/catalog/status', { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'discovered'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'deprecated'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'pendingPricing'));
});

test('cron：未配置 CRON_SECRET -> 503（不依赖环境是否已设该变量）', async () => {
  // config.cronSecret 是实时读 process.env.CRON_SECRET 的 getter，
  // 故通过临时清空/恢复环境变量来隔离，避免本地/Render .env 已配 CRON_SECRET 时误得 401。
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const res = await req('/api/cron/catalog-sync', { method: 'POST', headers: { 'x-cron-secret': 'anything' } });
    assert.equal(res.status, 503);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
});

test('cron：已配置 CRON_SECRET 但签名错误 -> 401', async () => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'expected-secret-xyz';
  try {
    const bad = await req('/api/cron/catalog-sync', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } });
    assert.equal(bad.status, 401);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
});
