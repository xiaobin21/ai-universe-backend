'use strict';

/**
 * 预算门（契约 §13）。调用前校验：每日费用上限、单任务预算、并发在跑数。
 * 金额整数 micro。超限抛 AppError('budget')（HTTP 402，不可重试）。
 */

const { query } = require('../../db/pool');
const { AppError } = require('../errors');
const { config } = require('../../config');

/** 单任务预算 = 每日预算的 20%（整数 floor）。 */
function perTaskBudget(dailyBudgetMicro) {
  return Math.floor(Math.max(0, Math.trunc(dailyBudgetMicro)) * 0.2);
}

/** 读取用户每日预算（user_settings.budget_daily_micro），缺省用配置默认值。 */
async function dailyBudgetMicro(userId) {
  const { rows } = await query(
    'SELECT budget_daily_micro AS "budget" FROM user_settings WHERE user_id = $1',
    [userId]
  );
  if (!rows.length || rows[0].budget === null || rows[0].budget === undefined) {
    return config.defaultDailyBudgetMicro;
  }
  return Number(rows[0].budget);
}

/** 今日已花费（micro）。按服务器本地日界 date_trunc('day', now())。 */
async function spentTodayMicro(userId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(cost_micro),0)::bigint AS "spent"
       FROM usage_records
      WHERE user_id = $1
        AND priced_at >= date_trunc('day', now())`,
    [userId]
  );
  return Number(rows[0].spent || 0);
}

/**
 * 每日预算门：已花 + 本次预计 > 每日预算 则抛 budget。
 * @returns {Promise<{dailyBudgetMicro:number, spentTodayMicro:number, remainingMicro:number}>}
 */
async function checkDailyBudget(userId, additionalMicro = 0) {
  const daily = await dailyBudgetMicro(userId);
  const spent = await spentTodayMicro(userId);
  const extra = Math.max(0, Math.trunc(additionalMicro));
  if (spent + extra > daily) {
    throw new AppError(
      'budget',
      `超出每日预算：已花 ${spent} + 本次 ${extra} > 上限 ${daily} micro`
    );
  }
  return { dailyBudgetMicro: daily, spentTodayMicro: spent, remainingMicro: daily - spent - extra };
}

/** 该用户当前 queued/running 的生成任务数（并发生成门用）。 */
async function countRunning(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM generation_jobs
      WHERE user_id = $1 AND status IN ('queued','running')`,
    [userId]
  );
  return Number(rows[0].n || 0);
}

module.exports = {
  perTaskBudget,
  dailyBudgetMicro,
  spentTodayMicro,
  checkDailyBudget,
  countRunning,
};
