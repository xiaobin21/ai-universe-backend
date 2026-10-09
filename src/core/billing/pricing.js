'use strict';

/**
 * 价格查询（契约 §13）。
 * getPricing(provider, model, at=now)：按 priced_at 落在 pricing_versions 区间取价。
 * 区间规则：effective_from <= at AND (effective_to IS NULL OR effective_to > at)。
 * 禁止用「现价」回溯历史 —— 历史计费必须取当时生效的那一版。
 *
 * 注意：pricing_versions.model 存的是「供应商原生模型 slug」（与 seed 一致）。
 */

const { query } = require('../../db/pool');
const { AppError } = require('../errors');

/**
 * @param {string} provider 供应商 slug，如 'deepseek'
 * @param {string} model 供应商原生模型名，如 'deepseek-chat'
 * @param {Date|string|number} [at] 取价时点，默认 now()
 * @returns {Promise<{inputMicroPerMtok:number, outputMicroPerMtok:number, currency:string}>}
 */
async function getPricing(provider, model, at = new Date()) {
  const ts = at instanceof Date ? at : new Date(at);
  const { rows } = await query(
    `SELECT input_price_micro_per_mtok AS "inputMicroPerMtok",
            output_price_micro_per_mtok AS "outputMicroPerMtok",
            currency
       FROM pricing_versions
      WHERE provider = $1
        AND model    = $2
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to > $3)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [provider, model, ts]
  );
  if (!rows.length) {
    throw new AppError('notfound', `未配置价格：${provider}/${model} @ ${ts.toISOString()}`);
  }
  const r = rows[0];
  return {
    inputMicroPerMtok: Number(r.inputMicroPerMtok),
    outputMicroPerMtok: Number(r.outputMicroPerMtok),
    currency: r.currency || 'CNY',
  };
}

/**
 * 非抛出版取价：无当前价时返回 null（成本未知），绝不伪造/写 0。
 * 供计费层在「管理员补价前」使用（discovered/manual 模型尚无 pricing_versions）。
 */
async function getPricingOrNull(provider, model, at = new Date()) {
  const ts = at instanceof Date ? at : new Date(at);
  const { rows } = await query(
    `SELECT input_price_micro_per_mtok AS "inputMicroPerMtok",
            output_price_micro_per_mtok AS "outputMicroPerMtok",
            currency
       FROM pricing_versions
      WHERE provider = $1
        AND model    = $2
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to > $3)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [provider, model, ts]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    inputMicroPerMtok: Number(r.inputMicroPerMtok),
    outputMicroPerMtok: Number(r.outputMicroPerMtok),
    currency: r.currency || 'CNY',
  };
}

module.exports = { getPricing, getPricingOrNull };
