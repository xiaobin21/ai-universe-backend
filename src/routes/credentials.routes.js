'use strict';

/**
 * 凭证路由（契约 §8.3，前缀 /api/credentials，全部需登录）。
 *
 * 响应绝不回显完整 API Key：只给 maskedHint（前4后4）与 configured 布尔。
 */

const express = require('express');
const creds = require('../core/credentials/credentials.service');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function getClientIp(req) {
  return (req.headers && req.headers['x-real-ip']) || req.socket?.remoteAddress || req.ip || null;
}

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  // GET /api/credentials
  router.get('/', wrap(async (req, res) => {
    const list = await creds.listForUser(req.user.id);
    res.json({ credentials: list });
  }));

  // PUT /api/credentials/:provider
  router.put('/:provider', wrap(async (req, res) => {
    const apiKey = req.body && req.body.apiKey;
    const baseUrl = req.body && req.body.baseUrl;
    const out = await creds.upsert({
      userId: req.user.id,
      providerSlug: req.params.provider,
      apiKey,
      baseUrl,
      ip: getClientIp(req),
    });
    res.json(out);
  }));

  // DELETE /api/credentials/:provider
  router.delete('/:provider', wrap(async (req, res) => {
    await creds.remove({
      userId: req.user.id,
      providerSlug: req.params.provider,
      ip: getClientIp(req),
    });
    res.status(204).end();
  }));

  // POST /api/credentials/:provider/test —— 5s 最小鉴权探测
  router.post('/:provider/test', wrap(async (req, res) => {
    const out = await creds.testConnection({
      userId: req.user.id,
      providerSlug: req.params.provider,
    });
    res.json(out);
  }));

  return router;
}

module.exports = buildRouter;
