'use strict';

/**
 * 计费测试（契约 §0 / §13）。用 embedded-postgres 真实库 + 种子。
 * 覆盖：价格版本区间取价（不回溯现价）、整数计费已知值、幂等键去重、部分失败按实际 completion。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestPg } = require('./helpers/embedded-pg');

let t;
let query;
let usage, pricingMod, budget;

test.before(async () => {
  t = await startTestPg({ seed: true });
  ({ query } = require('../src/db/pool'));
  usage = require('../src/core/billing/usage');
  pricingMod = require('../src/core/billing/pricing');
  budget = require('../src/core/billing/budget');
  // 准备一个测试用户（usage_records.user_id 外键）
  await query(
    `INSERT INTO users(id, email, password_hash) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO NOTHING`,
    ['usr_bill', 'bill@test.local', 'x']
  );
});

test.after(async () => {
  const { endPool } = require('../src/db/pool');
  await endPool();
  await t.stop();
});

test('costFromPrice：整数公式分别 floor 后相加（已知值）', () => {
  // 1,000,000 tok 输入 × 2元/Mtok(=2_000_000 micro/Mtok) = 2_000_000 micro
  //   500,000 tok 输出 × 8元/Mtok(=8_000_000) = 4_000_000 micro；合计 6_000_000
  const r = usage.costFromPrice({
    promptTokens: 1_000_000, completionTokens: 500_000,
    inputMicroPerMtok: 2_000_000, outputMicroPerMtok: 8_000_000,
  });
  assert.equal(r.inputMicro, 2_000_000);
  assert.equal(r.outputMicro, 4_000_000);
  assert.equal(r.costMicro, 6_000_000);

  // 截断/取整边界：10 tok 输入 × 1元/Mtok = floor(10*1e6/1e6)=10；
  // 1,000,000 tok 输出 × 1 micro/Mtok = floor(1e6*1/1e6)=1；合计 11
  const r2 = usage.costFromPrice({
    promptTokens: 10, completionTokens: 1_000_000,
    inputMicroPerMtok: 1_000_000, outputMicroPerMtok: 1,
  });
  assert.equal(r2.costMicro, 11);
  // 零 token 不计费
  const r3 = usage.costFromPrice({
    promptTokens: 0, completionTokens: 0,
    inputMicroPerMtok: 5_000_000, outputMicroPerMtok: 5_000_000,
  });
  assert.equal(r3.costMicro, 0);
});

test('computeCostMicro：按种子价格算 deepseek-chat（2元/8元 每百万token）', async () => {
  const r = await usage.computeCostMicro({
    provider: 'deepseek', model: 'deepseek-chat',
    promptTokens: 1_000_000, completionTokens: 500_000,
  });
  // in=2元→2_000_000；out=8元→8_000_000；out 半量=4_000_000；合计 6_000_000
  assert.equal(r.costMicro, 6_000_000);
  assert.equal(r.currency, 'CNY');
});

test('getPricing：按 effective 区间取价，历史时点不用现价回溯', async () => {
  // 种子表有 UNIQUE(provider,model)，为测多版本区间，仅在测试库放开该唯一约束
  await query('ALTER TABLE pricing_versions DROP CONSTRAINT IF EXISTS pricing_versions_provider_model_key');
  await query(
    `INSERT INTO pricing_versions(id, provider, model, effective_from, effective_to,
        input_price_micro_per_mtok, output_price_micro_per_mtok, currency)
     VALUES
      ('pv_old','testprov','interval-model','2024-01-01 00:00+00','2025-01-01 00:00+00', 1, 1, 'CNY'),
      ('pv_new','testprov','interval-model','2025-01-01 00:00+00', NULL, 999, 999, 'CNY')`
  );

  // 旧区间内 → 低价
  const old = await pricingMod.getPricing('testprov', 'interval-model', new Date('2024-06-01T00:00Z'));
  assert.equal(old.inputMicroPerMtok, 1);
  assert.equal(old.outputMicroPerMtok, 1);

  // 现价 → 新价（而非被旧价“永远锁死”）
  const now = await pricingMod.getPricing('testprov', 'interval-model', new Date('2026-01-01T00:00Z'));
  assert.equal(now.inputMicroPerMtok, 999);

  // 边界：恰好 effective_to 时刻 → 旧版已关闭，取新版
  const edge = await pricingMod.getPricing('testprov', 'interval-model', new Date('2025-01-01T00:00Z'));
  assert.equal(edge.inputMicroPerMtok, 999);
});

test('recordUsage：同 idempotency_key 不重复记账', async () => {
  const idem = 'idem-bill-1';
  const a = await usage.recordUsage({
    userId: 'usr_bill', provider: 'deepseek', model: 'deepseek-chat',
    promptTokens: 100, completionTokens: 200, costMicro: 500,
    usageSource: 'upstream', idempotencyKey: idem,
  });
  assert.equal(a.deduplicated, false);

  const b = await usage.recordUsage({
    userId: 'usr_bill', provider: 'deepseek', model: 'deepseek-chat',
    promptTokens: 99999, completionTokens: 99999, costMicro: 99999, // 应被忽略
    usageSource: 'upstream', idempotencyKey: idem,
  });
  assert.equal(b.deduplicated, true);
  assert.equal(b.record.id, a.record.id);

  const { rows } = await query('SELECT count(*)::int AS n FROM usage_records WHERE idempotency_key=$1', [idem]);
  assert.equal(rows[0].n, 1);
});

test('部分失败/取消：按实际收到的 completion tokens 如实记账', async () => {
  // 上游只回了 120 token 就中断；不得按预估满额计费
  const partial = await usage.recordUsage({
    userId: 'usr_bill', provider: 'deepseek', model: 'deepseek-chat',
    promptTokens: 800, completionTokens: 120, costMicro: 0,
    usageSource: 'estimated', idempotencyKey: 'idem-partial-1',
  });
  assert.equal(partial.record.promptTokens, 800);
  assert.equal(partial.record.completionTokens, 120);

  // 用实际 completion 重算整数费用（不按满额）
  const cost = usage.costFromPrice({
    promptTokens: 800, completionTokens: 120,
    inputMicroPerMtok: 2_000_000, outputMicroPerMtok: 8_000_000,
  });
  // in=floor(800*2e6/1e6)=1600；out=floor(120*8e6/1e6)=960；合计 2560
  assert.equal(cost.inputMicro, 1600);
  assert.equal(cost.outputMicro, 960);
  assert.equal(cost.costMicro, 2560);
});

test('checkDailyBudget：超限抛 budget，perTaskBudget=daily*0.2', async () => {
  assert.equal(budget.perTaskBudget(1_000_000), 200_000);
  // 该用户今日花费为 0（前面写的是 micro，远低于默认 1e7 日预算）
  const ok = await budget.checkDailyBudget('usr_bill', 100);
  assert.ok(ok.remainingMicro >= 0);

  await assert.rejects(
    () => budget.checkDailyBudget('usr_bill', 99_999_999_999),
    (e) => { assert.equal(e.code, 'budget'); return true; }
  );
});

test('countRunning：初始为 0', async () => {
  const n = await budget.countRunning('usr_bill');
  assert.equal(n, 0);
});
