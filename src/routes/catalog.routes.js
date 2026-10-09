'use strict';

/**
 * 目录路由（契约 §8.2，前缀 /api/catalog，需登录）。
 *  GET / -> {
 *    providers:[{slug,name,kind,enabled}],
 *    models:[{id,provider,slug,displayName,isDefault,capabilities,pricing:{inputMicroPerMtok,outputMicroPerMtok,currency}}]
 *  }
 */

const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', wrap(async (req, res) => {
    const prov = await query(
      `SELECT slug, name, kind, enabled FROM providers ORDER BY slug`
    );
    const mods = await query(
      `SELECT m.id AS id, p.slug AS provider, m.slug AS slug, m.display_name AS "displayName",
              m.is_default AS "isDefault", mc.capabilities,
              pv.input_price_micro_per_mtok AS "inP", pv.output_price_micro_per_mtok AS "outP",
              pv.currency
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         LEFT JOIN model_capabilities mc ON mc.model_id = m.id
         LEFT JOIN pricing_versions pv
                ON pv.provider = p.slug AND pv.model = m.slug
               AND pv.effective_from <= now()
               AND (pv.effective_to IS NULL OR pv.effective_to > now())
         ORDER BY p.slug, m.display_name`
    );
    const models = mods.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      slug: r.slug,
      displayName: r.displayName,
      isDefault: !!r.isDefault,
      capabilities: r.capabilities || {},
      pricing: r.inP == null ? null : {
        inputMicroPerMtok: Number(r.inP),
        outputMicroPerMtok: Number(r.outP),
        currency: r.currency || 'CNY',
      },
    }));
    res.json({ providers: prov.rows, models });
  }));

  return router;
}

module.exports = buildRouter;
