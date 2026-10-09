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
const { query } = require('../db/pool');
const { AppError } = require('../core/errors');
const { requireAuth, requireAdmin } = require('../core/auth/middleware');

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

  return router;
}

module.exports = buildRouter;
module.exports.detectErrorRateBreach = detectErrorRateBreach;
module.exports.detectCostSurge = detectCostSurge;
module.exports.isReadonly = isReadonly;
module.exports.setReadonly = setReadonly;
