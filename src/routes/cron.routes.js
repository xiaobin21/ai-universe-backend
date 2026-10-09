'use strict';

/**
 * Cron 路由（契约 §6）：公开但需签名，不挂 requireAdmin。
 *  - POST /catalog-sync  校验 X-Cron-Secret；CRON_SECRET 未配置 -> 503。
 *    命中则跑一次「平台 key」发现（可选 body {probe:true}）。
 */

const express = require('express');
const crypto = require('node:crypto');
const { config } = require('../config');
const { AppError } = require('../core/errors');
const { defaultCatalogDiscovery } = require('../core/discovery/catalogDiscovery');
const { defaultModelHealthProbe } = require('../core/discovery/modelHealthProbe');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function buildRouter() {
  const router = express.Router();
  const discovery = defaultCatalogDiscovery();
  const probe = defaultModelHealthProbe();

  router.post('/catalog-sync', wrap(async (req, res) => {
    const secret = config.cronSecret;
    if (!secret) {
      // 未配置签名密钥：拒绝触发，避免未鉴权调用
      return res.status(503).json({ error: { code: 'unavailable', message: 'CRON_SECRET 未配置' } });
    }
    const provided = String((req.headers && req.headers['x-cron-secret']) || '');
    if (!provided || !timingSafeEqual(provided, secret)) {
      throw new AppError('auth', 'cron 签名无效');
    }
    // cron 触发只用平台 key，绝不读取任何用户凭证
    const summary = await discovery.run({ trigger: 'cron', adminUserId: null });
    let probeSummary = null;
    if (req.body && req.body.probe) {
      probeSummary = await probe.run({ trigger: 'startup', adminUserId: null });
    }
    res.json({ discovery: summary, probe: probeSummary });
  }));

  return router;
}

module.exports = buildRouter;
