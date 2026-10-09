'use strict';

/**
 * 用量与计费（契约 §0 / §13）。
 * - 金额一律整数 micro（1 元 = 1e6）；价格单位 micro/百万 token。
 * - costMicro = floor(promptTokens * inPricePerMtok / 1e6) + floor(completionTokens * outPricePerMtok / 1e6)
 *   输入、输出分别 floor 后整数相加，禁止 float 累加金额。
 * - recordUsage 按 idempotency_key 去重：同一幂等键已记账则直接返回旧记录，不重复写。
 * - 部分失败/取消：调用方传入「实际已收到」的 completionTokens，本模块如实记账。
 */

const crypto = require('node:crypto');
const { query } = require('../../db/pool');
const { estimateTokens } = require('./tokenEstimate');

const MICRO_PER_MTOK = 1_000_000;

/** pg 默认把 BIGINT 返为字符串；统一把数值列转 Number，调用方拿到数字。
 *  cost_micro 允许 NULL（价格缺失=成本未知），必须保留 null，不得 Number(null)→0。 */
function normalizeRow(r) {
  return {
    ...r,
    promptTokens: Number(r.promptTokens),
    completionTokens: Number(r.completionTokens),
    costMicro: r.costMicro == null ? null : Number(r.costMicro),
  };
}

/**
 * 纯函数：已知价格时计算整数费用。不查库，便于单测已知值。
 * @param {{promptTokens:number, completionTokens:number,
 *          inputMicroPerMtok:number, outputMicroPerMtok:number}} p
 * @returns {{costMicro:number, inputMicro:number, outputMicro:number}}
 */
function costFromPrice({ promptTokens, completionTokens, inputMicroPerMtok, outputMicroPerMtok }) {
  const pt = Math.max(0, Math.trunc(promptTokens));
  const ct = Math.max(0, Math.trunc(completionTokens));
  const inP = Math.max(0, Math.trunc(inputMicroPerMtok));
  const outP = Math.max(0, Math.trunc(outputMicroPerMtok));
  // 分别 floor 后相加；量级远小于 2^53，Number 安全
  const inputMicro = Math.floor((pt * inP) / MICRO_PER_MTOK);
  const outputMicro = Math.floor((ct * outP) / MICRO_PER_MTOK);
  return { costMicro: inputMicro + outputMicro, inputMicro, outputMicro };
}

/**
 * 查库取价后计算整数费用。
 * @param {{provider:string, model:string, promptTokens:number, completionTokens:number,
 *          at?: Date|string|number}} args
 */
async function computeCostMicro({ provider, model, promptTokens, completionTokens, at = new Date() }) {
  const { getPricingOrNull } = require('./pricing'); // 延迟 require 避免循环依赖
  const price = await getPricingOrNull(provider, model, at);
  if (!price) {
    // 无当前价：成本未知（discovered/manual 且管理员尚未补价）。绝不写 0 或假价。
    return { costMicro: null, inputMicro: 0, outputMicro: 0, currency: null, unknown: true };
  }
  const res = costFromPrice({
    promptTokens,
    completionTokens,
    inputMicroPerMtok: price.inputMicroPerMtok,
    outputMicroPerMtok: price.outputMicroPerMtok,
  });
  return { ...res, currency: price.currency, unknown: false };
}

/**
 * 上游未回传用量时的保守文本估算（契约 §13）。
 * @param {{promptTexts: string[], completionText?: string}} args
 * @returns {{promptTokens:number, completionTokens:number, usageSource:'estimated'}}
 */
function estimateUsageFromText({ promptTexts, completionText = '' }) {
  const promptTokens = (promptTexts || []).reduce((sum, t) => sum + estimateTokens(t || ''), 0);
  const completionTokens = estimateTokens(completionText || '');
  return { promptTokens, completionTokens, usageSource: 'estimated' };
}

/**
 * 写一条 usage_records；同 idempotency_key 已存在则返回旧记录不重复记账。
 * @param {{userId:string, jobId?:string|null, provider:string, model:string,
 *          promptTokens:number, completionTokens:number, costMicro:number,
 *          currency?:string, usageSource?:'upstream'|'estimated',
 *          pricedAt?:Date|string, idempotencyKey?:string|null}} args
 * @returns {Promise<{record:object, deduplicated:boolean}>}
 */
async function recordUsage({
  userId, jobId = null, provider, model,
  promptTokens = 0, completionTokens = 0, costMicro = 0,
  currency = 'CNY', usageSource = 'estimated',
  pricedAt = new Date(), idempotencyKey = null,
}) {
  // costMicro === null/undefined 表示成本未知（无价），写 NULL，绝不落 0。
  const costParam = (costMicro === null || costMicro === undefined)
    ? null
    : Math.trunc(costMicro);
  const currencyParam = (costParam === null && currency === null) ? 'CNY' : currency;
  // 幂等去重：同键已记账则直接返回
  if (idempotencyKey) {
    const existing = await query(
      `SELECT id, user_id AS "userId", job_id AS "jobId", provider, model,
              prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              cost_micro AS "costMicro", currency, usage_source AS "usageSource",
              priced_at AS "pricedAt", idempotency_key AS "idempotencyKey"
         FROM usage_records WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (existing.rows.length) {
      return { record: normalizeRow(existing.rows[0]), deduplicated: true };
    }
  }

  const id = `use_${crypto.randomUUID()}`;
  const insert = await query(
    `INSERT INTO usage_records
       (id, user_id, job_id, provider, model, prompt_tokens, completion_tokens,
        cost_micro, currency, usage_source, priced_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, user_id AS "userId", job_id AS "jobId", provider, model,
              prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              cost_micro AS "costMicro", currency, usage_source AS "usageSource",
              priced_at AS "pricedAt", idempotency_key AS "idempotencyKey"`,
    [id, userId, jobId, provider, model,
     Math.trunc(promptTokens), Math.trunc(completionTokens), costParam,
     currencyParam, usageSource, pricedAt, idempotencyKey]
  );
  return { record: normalizeRow(insert.rows[0]), deduplicated: false };
}

module.exports = {
  costFromPrice,
  computeCostMicro,
  estimateUsageFromText,
  recordUsage,
  MICRO_PER_MTOK,
};
