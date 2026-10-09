'use strict';

/**
 * 目录路由（契约 §8.2，前缀 /api/catalog，需登录）。
 *  GET / -> {
 *    providers:[{slug,name,kind,enabled}],
 *    models:[{id,provider,slug,displayName,isDefault,
 *             source,lifecycle,capabilitiesVerified,
 *             firstSeenAt,lastSeenAt,lastCheckedAt,deprecationReason,
 *             capabilities,pricing:{inputMicroPerMtok,outputMicroPerMtok,currency}|null}]
 *  }
 *
 * 动态目录口径（契约 §7）：
 *  - 默认隐藏 lifecycle IN ('deprecated','hidden') 的模型（已停用/人工隐藏）；
 *    仅当 ?include_deprecated=true 时返回全部（管理员视图用）。
 *  - pricing 为 null 表示「价格待补充」，绝不回填 0 或估算假价。
 */

const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', wrap(async (req, res) => {
    // include_deprecated=true 时返回全部模型（管理员补价/启用用）；默认只看 active
    const includeDeprecated = String(req.query.include_deprecated || '').toLowerCase() === 'true';

    const prov = await query(
      `SELECT slug, name, kind, enabled FROM providers ORDER BY slug`
    );
    const mods = await query(
      `SELECT m.id AS id, p.slug AS provider, m.slug AS slug, m.display_name AS "displayName",
              m.is_default AS "isDefault",
              m.source AS "source",
              m.lifecycle AS "lifecycle",
              m.capabilities_verified AS "capabilitiesVerified",
              m.first_seen_at AS "firstSeenAt",
              m.last_seen_at AS "lastSeenAt",
              m.last_checked_at AS "lastCheckedAt",
              m.deprecation_reason AS "deprecationReason",
              mc.capabilities,
              pv.input_price_micro_per_mtok AS "inP", pv.output_price_micro_per_mtok AS "outP",
              pv.currency
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         LEFT JOIN model_capabilities mc ON mc.model_id = m.id
         LEFT JOIN pricing_versions pv
                ON pv.provider = p.slug AND pv.model = m.slug
               AND pv.effective_from <= now()
               AND (pv.effective_to IS NULL OR pv.effective_to > now())
        WHERE ($1::boolean OR m.lifecycle NOT IN ('deprecated','hidden'))
        ORDER BY p.slug, m.display_name`,
      [includeDeprecated]
    );
    const models = mods.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      slug: r.slug,
      displayName: r.displayName,
      isDefault: !!r.isDefault,
      // 动态目录元信息（迁移 003）
      source: r.source || 'seeded',
      lifecycle: r.lifecycle || 'active',
      capabilitiesVerified: r.capabilitiesVerified === true || r.capabilitiesVerified === 't',
      firstSeenAt: r.firstSeenAt || null,
      lastSeenAt: r.lastSeenAt || null,
      lastCheckedAt: r.lastCheckedAt || null,
      deprecationReason: r.deprecationReason || null,
      capabilities: r.capabilities || {},
      // 无当前价格版本 -> null（成本未知），绝不填 0
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
