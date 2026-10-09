'use strict';

/**
 * 请求幂等（契约 §0.7 / §13 重复请求 / 提示词硬要求 2）。
 *
 * 以 Postgres `idempotency_keys` 表为唯一权威：
 *  - 同一 (key, scope) 重复提交时，绝不新建任务 / 二次调用上游。
 *  - 键处于 processing（对应任务在跑）：返回 jobId，由上层「挂接/重放」该任务的实时流。
 *  - 键处于 done / error：返回 jobId + resultRef，由上层重放已落库的 generation_events，
 *    得到最终结果。
 *
 * 注意：UNIQUE(key) 即唯一约束（见 001_init.sql），冲突即同键重放。
 */

const crypto = require('node:crypto');
const { query } = require('../../db/pool');
const { AppError } = require('../errors');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * 尝试为一次请求「认领」一个幂等键。
 * @param {{key:string, userId:string, scope?:string, jobId?:string|null}} args
 * @returns {Promise<{outcome:'claimed'|'replay_running'|'replay_done', jobId:string|null, row:object|null}>}
 */
async function claimKey({ key, userId, scope = 'chat', jobId = null }) {
  if (!key || typeof key !== 'string') {
    throw new AppError('badreq', '缺少 Idempotency-Key');
  }
  try {
    await query(
      `INSERT INTO idempotency_keys(id, key, user_id, scope, job_id, status, expires_at)
       VALUES($1,$2,$3,$4,$5,'processing', now() + interval '24 hours')`,
      [genId('idem'), key, userId, scope, jobId]
    );
    return { outcome: 'claimed', jobId, row: null };
  } catch (e) {
    // 唯一约束冲突：同键已存在
    if (e && (e.code === '23505' || e.constraint === 'idempotency_keys_key_key')) {
      const r = await query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
      const row = r.rows[0];
      if (!row) {
        // 理论上不应发生；兜底再插一次
        return claimKey({ key, userId, scope, jobId });
      }
      // 跨用户使用同一 key 视为冲突，不泄露他人任务
      if (row.user_id !== userId) {
        throw new AppError('conflict', '幂等键已被其他请求占用');
      }
      const outcome =
        row.status === 'done' || row.status === 'error' ? 'replay_done' : 'replay_running';
      return { outcome, jobId: row.job_id || jobId, row };
    }
    throw e;
  }
}

/** 认领后回填 jobId（claim 时尚未生成 jobId 的场景）。 */
async function attachJob(key, jobId) {
  await query(
    `UPDATE idempotency_keys SET job_id = $2 WHERE key = $1`,
    [key, jobId]
  );
}

/** 标记为完成，并记录结果引用（通常为 jobId）。 */
async function markDone(key, resultRef) {
  await query(
    `UPDATE idempotency_keys SET status = 'done', result_ref = $2 WHERE key = $1`,
    [key, resultRef || null]
  );
}

/** 标记为错误（失败），供重放时返回错误终态。 */
async function markError(key, resultRef) {
  await query(
    `UPDATE idempotency_keys SET status = 'error', result_ref = $2 WHERE key = $1`,
    [key, resultRef || null]
  );
}

module.exports = { claimKey, attachJob, markDone, markError };
