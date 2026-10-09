'use strict';

/**
 * ModelHealthProbe 集成 + 分类单测（真实 embedded PostgreSQL，mock 上游 transport，不扣费）。
 * 覆盖：404 / 400 退役文案 -> deprecated；401/402/429/5xx/超时 -> 保持 active 仅更新 last_checked_at。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestPg } = require('../helpers/embedded-pg');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY_ID = process.env.ENCRYPTION_KEY_ID || 'k1';
if (!process.env.MASTER_ENCRYPTION_KEY) {
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}

const { query, endPool } = require('../../src/db/pool');
const { createModelHealthProbe, classifyProbeResponse } = require('../../src/core/discovery/modelHealthProbe');

let pg;

/** 按被测模型的 providerModel 决定返回什么 HTTP 状态/体。 */
function fakeTransport(decision) {
  return async (url, opts) => {
    let model = '';
    try { model = JSON.parse(opts.body || '{}').model || ''; } catch { /* ignore */ }
    const d = decision[model] || { status: 200, text: '{}' };
    return { status: d.status, raw: { text: async () => d.text || '{}' } };
  };
}

function makeDeps(decision) {
  return {
    transport: fakeTransport(decision),
    getDecryptedCredential: async () => { throw new Error('nokey'); },
    getPlatformKey: () => 'plat-key',
    getPlatformBaseUrl: () => null,
    config: { modelProbeConcurrency: 2 },
  };
}

async function modelState(slug) {
  const r = await query(
    `SELECT m.lifecycle, m.last_checked_at AS "lastCheckedAt", m.deprecation_reason AS reason
       FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.slug=$1`,
    [slug]
  );
  return r.rows[0] || null;
}

test.before(async () => {
  pg = await startTestPg({ seed: true });
});
test.after(async () => {
  await endPool().catch(() => {});
  if (pg) await pg.stop();
});

test('探测：404 与 400 退役文案 -> deprecated 并记 reason', async () => {
  const deps = makeDeps({
    'gpt-4o': { status: 404, text: '{}' },
    'gpt-4o-mini': { status: 400, text: JSON.stringify({ error: { code: 'model_not_found', message: 'The model has been decommissioned' } }) },
  });
  const probe = createModelHealthProbe(deps);
  const sum = await probe.run({ trigger: 'manual' });
  assert.ok(sum.totals.deprecated >= 2);
  const a = await modelState('gpt-4o');
  assert.equal(a.lifecycle, 'deprecated');
  assert.match(a.reason, /退役|404/);
  const b = await modelState('gpt-4o-mini');
  assert.equal(b.lifecycle, 'deprecated');
  assert.match(b.reason, /model_not_found|decommissioned/i);
});

test('探测：401/402/429/5xx -> 保持 active，仅更新 last_checked_at', async () => {
  // 先重置上一用例被停用的两行，保证本用例从 active 探测
  await query(`UPDATE models SET lifecycle='active', deprecation_reason=NULL WHERE slug IN ('gpt-4o','gpt-4o-mini')`);
  const deps = makeDeps({
    'gpt-4o': { status: 401, text: '{}' },
    'gpt-4o-mini': { status: 402, text: '{}' },
    'gpt-4.1': { status: 429, text: '{}' },
    'o3-mini': { status: 503, text: '{}' },
  });
  const probe = createModelHealthProbe(deps);
  const sum = await probe.run({ trigger: 'manual' });
  for (const s of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini']) {
    const row = await modelState(s);
    assert.equal(row.lifecycle, 'active', `${s} 不应被停用`);
    assert.ok(row.lastCheckedAt, `${s} 应更新 last_checked_at`);
  }
  assert.equal(sum.totals.deprecated, 0);
});

// ---------- 纯分类器单测 ----------

test('classifyProbeResponse：404 必退役；400 命中关键词退役', () => {
  assert.equal(classifyProbeResponse({ status: 404, text: '' }).outcome, 'deprecated');
  assert.equal(classifyProbeResponse({ status: 400, text: JSON.stringify({ error: { code: 'x', message: 'model does not exist' } }) }).outcome, 'deprecated');
  assert.equal(classifyProbeResponse({ status: 400, text: '{"error":{"message":"该模型已下线"}}' }).outcome, 'deprecated');
});

test('classifyProbeResponse：400 非退役文案 / 401/402/429/500 保持 active', () => {
  assert.equal(classifyProbeResponse({ status: 400, text: 'invalid prompt' }).outcome, 'keptActive');
  for (const s of [401, 402, 403, 429, 500, 502, 503]) {
    assert.equal(classifyProbeResponse({ status: s, text: '' }).outcome, 'keptActive');
  }
});
