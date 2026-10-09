'use strict';

/**
 * 用量路由（契约 §8.6，前缀 /api/usage，全部需登录）。
 *  - GET /summary -> {today:{costMicro,tokens,calls}, month:{costMicro}, byModel:[{modelId,costMicro}], byProvider:[{provider,costMicro}]}
 *  - GET /records?from=&to= -> [usage_records]
 */

const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/summary', wrap(async (req, res) => {
    const uid = req.user.id;
    const agg = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN priced_at >= date_trunc('day', now()) THEN cost_micro ELSE 0 END),0)::bigint AS "todayCost",
         COALESCE(SUM(CASE WHEN priced_at >= date_trunc('day', now()) THEN prompt_tokens+completion_tokens ELSE 0 END),0)::bigint AS "todayTokens",
         COUNT(CASE WHEN priced_at >= date_trunc('day', now()) THEN 1 END)::int AS "todayCalls",
         COALESCE(SUM(CASE WHEN priced_at >= date_trunc('month', now()) THEN cost_micro ELSE 0 END),0)::bigint AS "monthCost"
       FROM usage_records WHERE user_id=$1`,
      [uid]
    );
    const a = agg.rows[0];
    const byModel = await query(
      `SELECT m.id AS "modelId", COALESCE(SUM(ur.cost_micro),0)::bigint AS "costMicro"
         FROM usage_records ur LEFT JOIN models m ON m.slug = ur.model
        WHERE ur.user_id=$1 GROUP BY m.id ORDER BY "costMicro" DESC`,
      [uid]
    );
    const byProvider = await query(
      `SELECT provider, COALESCE(SUM(cost_micro),0)::bigint AS "costMicro"
         FROM usage_records WHERE user_id=$1 GROUP BY provider ORDER BY "costMicro" DESC`,
      [uid]
    );
    res.json({
      today: { costMicro: Number(a.todayCost), tokens: Number(a.todayTokens), calls: Number(a.todayCalls) },
      month: { costMicro: Number(a.monthCost) },
      byModel: byModel.rows,
      byProvider: byProvider.rows,
    });
  }));

  router.get('/records', wrap(async (req, res) => {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const r = await query(
      `SELECT id, provider, model, prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              cost_micro AS "costMicro", usage_source AS "usageSource", priced_at AS "pricedAt"
         FROM usage_records
        WHERE user_id=$1
          AND ($2::timestamptz IS NULL OR priced_at >= $2)
          AND ($3::timestamptz IS NULL OR priced_at <= $3)
        ORDER BY priced_at DESC LIMIT 500`,
      [req.user.id, from, to]
    );
    res.json(r.rows);
  }));

  return router;
}

module.exports = buildRouter;
