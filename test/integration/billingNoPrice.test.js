'use strict';

/**
 * 计费完整性（契约 §8）：无当前价时成本写 NULL，绝不落 0 或假价；token 照常记录。
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
const { recordUsage, computeCostMicro } = require('../../src/core/billing/usage');

let pg;
test.before(async () => { pg = await startTestPg({ seed: false }); });
test.after(async () => { await endPool().catch(() => {}); if (pg) await pg.stop(); });

test('computeCostMicro：未知模型无价 -> costMicro=null（不抛错、不返回 0）', async () => {
  const res = await computeCostMicro({ provider: 'openai', model: 'totally-unknown-model-xyz', promptTokens: 100, completionTokens: 50 });
  assert.equal(res.costMicro, null);
  assert.equal(res.unknown, true);
});

test('recordUsage：costMicro=null 落库为 NULL，token 照常；读回仍是 null', async () => {
  // 需要一个存在的 user 与 provider（外键）。seed:false 下自建最小行。
  await query("INSERT INTO users(id,email,password_hash) VALUES('u_t','n@e.com','x') ON CONFLICT DO NOTHING");
  await query("INSERT INTO providers(id,slug,name) VALUES('prv_x','openai','OpenAI') ON CONFLICT DO NOTHING");
  const { record, deduplicated } = await recordUsage({
    userId: 'u_t', provider: 'openai', model: 'unknown-model',
    promptTokens: 123, completionTokens: 45, costMicro: null,
    idempotencyKey: null,
  });
  assert.equal(deduplicated, false);
  assert.equal(record.costMicro, null); // 不是 0
  assert.equal(record.promptTokens, 123);
  assert.equal(record.completionTokens, 45);

  const db = await query('SELECT cost_micro FROM usage_records WHERE id=$1', [record.id]);
  assert.equal(db.rows[0].cost_micro, null);
});
