'use strict';

/**
 * 设置路由（契约 §8.7，前缀 /api/settings，全部需登录）。
 *  - GET /  -> {routingMode, defaultModelId, budgetDailyMicro, maxOutputTokens}（平铺）
 *  - PATCH / -> {routingMode?, defaultModelId?, budgetDailyMicro?, maxOutputTokens?}
 */

const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function flatten(row) {
  return {
    routingMode: row ? row.routing_mode : 'manual',
    defaultModelId: row ? row.default_model_id : null,
    budgetDailyMicro: row ? Number(row.budget_daily_micro) : 10_000_000,
    maxOutputTokens: row ? Number(row.max_output_tokens) : 4096,
  };
}

async function ensureRow(userId) {
  await query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const r = await query('SELECT * FROM user_settings WHERE user_id=$1', [userId]);
  return r.rows[0];
}

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', wrap(async (req, res) => {
    const row = await ensureRow(req.user.id);
    res.json(flatten(row));
  }));

  router.patch('/', wrap(async (req, res) => {
    const { routingMode, defaultModelId, budgetDailyMicro, maxOutputTokens } = req.body || {};
    await ensureRow(req.user.id);
    await query(
      `UPDATE user_settings SET
         routing_mode      = COALESCE($2, routing_mode),
         default_model_id  = COALESCE($3, default_model_id),
         budget_daily_micro = COALESCE($4, budget_daily_micro),
         max_output_tokens  = COALESCE($5, max_output_tokens)
       WHERE user_id=$1`,
      [
        req.user.id,
        routingMode ?? null,
        defaultModelId ?? null,
        budgetDailyMicro === undefined ? null : Math.trunc(Number(budgetDailyMicro)),
        maxOutputTokens === undefined ? null : Math.trunc(Number(maxOutputTokens)),
      ]
    );
    const row = await query('SELECT * FROM user_settings WHERE user_id=$1', [req.user.id]);
    res.json(flatten(row.rows[0]));
  }));

  return router;
}

module.exports = buildRouter;
