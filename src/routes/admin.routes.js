'use strict';

/**
 * 管理员路由（契约 §8.8，前缀 /api/admin，tier='admin'）。
 *  - POST /providers/:slug/disable|enable   熔断 / 恢复
 *  - POST /users/:id/disable|enable         停用 / 启用
 *  - POST /readonly {on}                    全局只读（内存标志 + 文件持久化，启动恢复）
 *
 * 异常检测（纯函数，供测试与监控复用）：
 *   detectErrorRateBreach({requests1m, errors1m, minSamples=10}) -> bool   5xx 率 >30% 且样本足够
 *   detectCostSurge({prevCost, currentCost, ratio=5}) -> bool               费用突增 >5 倍
 * 命中即写 audit_logs 并自动熔断对应 provider。
 */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { query } = require('../db/pool');
const { AppError } = require('../core/errors');
const { requireAuth, requireAdmin } = require('../core/auth/middleware');
const { defaultCatalogDiscovery } = require('../core/discovery/catalogDiscovery');
const { defaultModelHealthProbe } = require('../core/discovery/modelHealthProbe');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const READONLY_FILE = process.env.READONLY_STATE_FILE || path.join(process.cwd(), '.readonly');

// ---- 全局只读：内存 + 文件持久化 ----
let globalReadonly = false;
try { if (fs.existsSync(READONLY_FILE)) globalReadonly = fs.readFileSync(READONLY_FILE, 'utf8').trim() === '1'; } catch (_) { /* 忽略 */ }
function isReadonly() { return globalReadonly; }
function setReadonly(on) {
  globalReadonly = !!on;
  try { fs.writeFileSync(READONLY_FILE, globalReadonly ? '1' : '0'); } catch (_) { /* 忽略 */ }
  return globalReadonly;
}

// ---- 纯检测函数 ----
function detectErrorRateBreach({ requests1m = 0, errors1m = 0, minSamples = 10 } = {}) {
  if (requests1m < minSamples) return false; // 样本不足不判，避免误熔断
  return errors1m / requests1m > 0.3;
}
function detectCostSurge({ prevCost = 0, currentCost = 0, ratio = 5 } = {}) {
  if (prevCost <= 0) return false; // 无基线不判
  return currentCost > prevCost * ratio;
}

async function auditAdmin({ userId, action, meta }) {
  await query(
    'INSERT INTO audit_logs(id, user_id, action, meta_json) VALUES($1,$2,$3,$4::jsonb)',
    ['aud_' + require('crypto').randomBytes(12).toString('hex'), userId, action, JSON.stringify(meta || {})]
  ).catch(() => {});
}

async function setProviderCircuit(slug, open) {
  await query('UPDATE providers SET circuit_open=$2 WHERE slug=$1', [slug, open]);
}

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  router.post('/providers/:slug/disable', wrap(async (req, res) => {
    await setProviderCircuit(req.params.slug, true);
    await auditAdmin({ userId: req.user.id, action: 'admin.provider.disable', meta: { slug: req.params.slug } });
    res.json({ provider: req.params.slug, circuitOpen: true });
  }));

  router.post('/providers/:slug/enable', wrap(async (req, res) => {
    await setProviderCircuit(req.params.slug, false);
    await auditAdmin({ userId: req.user.id, action: 'admin.provider.enable', meta: { slug: req.params.slug } });
    res.json({ provider: req.params.slug, circuitOpen: false });
  }));

  router.post('/users/:id/disable', wrap(async (req, res) => {
    await query('UPDATE users SET disabled_at=now() WHERE id=$1', [req.params.id]);
    await auditAdmin({ userId: req.user.id, action: 'admin.user.disable', meta: { target: req.params.id } });
    res.json({ user: req.params.id, disabled: true });
  }));

  router.post('/users/:id/enable', wrap(async (req, res) => {
    await query('UPDATE users SET disabled_at=NULL WHERE id=$1', [req.params.id]);
    await auditAdmin({ userId: req.user.id, action: 'admin.user.enable', meta: { target: req.params.id } });
    res.json({ user: req.params.id, disabled: false });
  }));

  router.post('/readonly', wrap(async (req, res) => {
    const on = !!(req.body && req.body.on);
    setReadonly(on);
    await auditAdmin({ userId: req.user.id, action: 'admin.readonly', meta: { on } });
    res.json({ readonly: on });
  }));

  router.get('/readonly', wrap(async (req, res) => res.json({ readonly: isReadonly() })));

  // ================= 动态模型目录（契约 §4/§5/§6） =================
  const discovery = defaultCatalogDiscovery();
  const probe = defaultModelHealthProbe();

  // POST /catalog/sync {probe?:bool}：跑一次发现；probe=true 再跑探测
  router.post('/catalog/sync', wrap(async (req, res) => {
    const summary = await discovery.run({ trigger: 'manual', adminUserId: req.user.id });
    let probeSummary = null;
    if (req.body && req.body.probe) {
      probeSummary = await probe.run({ trigger: 'manual', adminUserId: req.user.id });
    }
    res.json({ discovery: summary, probe: probeSummary });
  }));

  // POST /catalog/probe：只跑健康探测
  router.post('/catalog/probe', wrap(async (req, res) => {
    const summary = await probe.run({ trigger: 'manual', adminUserId: req.user.id });
    res.json(summary);
  }));

  // GET /catalog/status：最近运行 + 新发现/已停用/待补价清单
  router.get('/catalog/status', wrap(async (req, res) => {
    const lastDiscovery = discovery.getLastRun();
    const lastProbe = probe.getLastRun();

    const list = await query(
      `SELECT m.id, p.slug AS "provider", m.slug, m.display_name AS "displayName",
              m.lifecycle, m.capabilities_verified AS "capabilitiesVerified",
              m.first_seen_at AS "firstSeenAt", m.last_seen_at AS "lastSeenAt",
              m.deprecation_reason AS "deprecationReason"
         FROM models m JOIN providers p ON p.id = m.provider_id
        ORDER BY m.created_at DESC`
    );
    const priceRows = await query(
      `SELECT provider, model FROM pricing_versions WHERE effective_to IS NULL`
    );
    const priced = new Set(priceRows.rows.map((r) => `${r.provider}/${r.model}`));

    const discovered = [];
    const deprecated = [];
    const pendingPricing = [];
    for (const r of list.rows) {
      const pricedKey = `${r.provider}/${r.slug}`;
      const item = {
        id: r.id, provider: r.provider, slug: r.slug, displayName: r.displayName,
        lifecycle: r.lifecycle, capabilitiesVerified: r.capabilitiesVerified,
        pricing: priced.has(pricedKey) ? { known: true } : null,
        firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
      };
      if (r.lifecycle === 'deprecated') {
        deprecated.push({ ...item, deprecationReason: r.deprecationReason });
      }
      if (r.capabilitiesVerified === false && r.lifecycle !== 'deprecated') {
        discovered.push(item);
      }
      if ((!priced.has(pricedKey))) {
        pendingPricing.push({ id: r.id, provider: r.provider, slug: r.slug, displayName: r.displayName });
      }
    }

    res.json({
      lastDiscovery: lastDiscovery ? { ranAt: lastDiscovery.ranAt, trigger: lastDiscovery.trigger, totals: lastDiscovery.totals } : null,
      lastProbe: lastProbe ? { ranAt: lastProbe.ranAt, totals: lastProbe.totals } : null,
      discovered, deprecated, pendingPricing,
    });
  }));

  // PATCH /models/:id：改生命周期/能力/上下文/价格，重新启用；非管理员已被 requireAdmin 拦为 403
  router.patch('/models/:id', wrap(async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const cur = await query(
      `SELECT m.id, p.slug AS provider, m.slug, m.source, m.lifecycle, m.capabilities
         FROM models m JOIN providers p ON p.id = m.provider_id
         LEFT JOIN model_capabilities mc ON mc.model_id = m.id
        WHERE m.id = $1`,
      [id]
    );
    if (!cur.rows.length) throw new AppError('notfound', '模型不存在');
    const row = cur.rows[0];

    // 是否仅补价（决定 seeded 是否保留 source）
    const onlyPricing = Object.keys(body).every((k) => k === 'pricing');
    let madeManual = false;

    // 1) 基础列更新
    const sets = [];
    const params = [id];
    let pi = 2;
    if (typeof body.lifecycle === 'string') {
      sets.push(`lifecycle=$${pi++}`); params.push(body.lifecycle);
      // 重新启用：清 reason、miss 归零
      if (body.lifecycle === 'active') {
        sets.push(`deprecation_reason=NULL`, `miss_count=0`);
      }
      madeManual = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'deprecationReason')) {
      sets.push(`deprecation_reason=$${pi++}`); params.push(body.deprecationReason || null);
      madeManual = true;
    }
    if (typeof body.displayName === 'string' && body.displayName.trim()) {
      sets.push(`display_name=$${pi++}`); params.push(body.displayName.trim());
      madeManual = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'capabilitiesVerified')) {
      sets.push(`capabilities_verified=$${pi++}`); params.push(!!body.capabilitiesVerified);
      madeManual = true;
    }
    // source：手工改动置 manual；seeded 且仅补价则保留
    if (madeManual && row.source !== 'manual') {
      sets.push(`source='manual'`);
    }
    if (sets.length) {
      await query(`UPDATE models SET ${sets.join(', ')} WHERE id=$1`, params);
    }

    // 2) 能力合并（JSON merge）+ contextWindow/maxOutputTokens
    if (body.capabilities || body.contextWindow || body.maxOutputTokens) {
      const current = (() => {
        const v = row.capabilities;
        if (!v) return {};
        return typeof v === 'string' ? JSON.parse(v) : v; // pg 已把 jsonb 解析为对象
      })();
      const merged = { ...current, ...(body.capabilities || {}) };
      if (Number.isFinite(body.contextWindow)) merged.contextWindow = body.contextWindow;
      if (Number.isFinite(body.maxOutputTokens)) merged.maxOutputTokens = body.maxOutputTokens;
      await query(
        `INSERT INTO model_capabilities(id, model_id, capabilities)
         VALUES($1,$2,$3::jsonb)
         ON CONFLICT (model_id) DO UPDATE SET capabilities=EXCLUDED.capabilities`,
        [`cap_${id}`, id, JSON.stringify(merged)]
      );
    }

    // 3) 价格：upsert 当前 pricing_versions（无则新建）
    if (body.pricing && typeof body.pricing === 'object') {
      const p = body.pricing;
      const inP = Math.trunc(Number(p.inputMicroPerMtok || 0));
      const outP = Math.trunc(Number(p.outputMicroPerMtok || 0));
      const currency = p.currency || 'CNY';
      await query(
        `UPDATE pricing_versions SET effective_to=now()
          WHERE provider=$1 AND model=$2 AND effective_to IS NULL`,
        [row.provider, row.slug]
      );
      await query(
        `INSERT INTO pricing_versions(id, provider, model, effective_from, effective_to,
            input_price_micro_per_mtok, output_price_micro_per_mtok, currency)
         VALUES($1,$2,$3,now(),NULL,$4,$5,$6)`,
        [`pv_${crypto.randomBytes(8).toString('hex')}`, row.provider, row.slug, inP, outP, currency]
      );
      if (!onlyPricing) madeManual = true;
    }

    await auditAdmin({ userId: req.user.id, action: 'admin.catalog.patchModel', meta: { id, body } });
    const updated = await query(
      `SELECT m.id, p.slug AS "provider", m.slug, m.display_name AS "displayName",
              m.lifecycle, m.capabilities_verified AS "capabilitiesVerified", m.source
         FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`,
      [id]
    );
    res.json(updated.rows[0]);
  }));

  return router;
}

module.exports = buildRouter;
module.exports.detectErrorRateBreach = detectErrorRateBreach;
module.exports.detectCostSurge = detectCostSurge;
module.exports.isReadonly = isReadonly;
module.exports.setReadonly = setReadonly;
