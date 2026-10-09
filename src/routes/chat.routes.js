'use strict';

/**
 * 生成任务路由（契约 §8.5，前缀 /api/chat，全部需登录）。
 *  - POST /jobs/:id/cancel -> {status, cancelRequestedAt}
 *  - GET  /jobs/:id        -> {job:{...}, usage}
 *  - GET  /jobs/:id/events?afterSeq= -> SSE/JSON 重放 generation_events（断线补流）
 */

const express = require('express');
const { AppError } = require('../core/errors');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  // POST /api/chat/jobs/:id/cancel
  router.post('/jobs/:id/cancel', wrap(async (req, res) => {
    const svc = req.app.locals.chatService;
    const out = await svc.cancelJob({ userId: req.user.id, jobId: req.params.id });
    res.json({ status: out.status, cancelRequestedAt: out.cancelRequestedAt, alreadyEnded: !!out.alreadyEnded });
  }));

  // GET /api/chat/jobs/:id
  router.get('/jobs/:id', wrap(async (req, res) => {
    const svc = req.app.locals.chatService;
    const out = await svc.getJob({ userId: req.user.id, jobId: req.params.id });
    res.json(out);
  }));

  // GET /api/chat/jobs/:id/events?afterSeq= -> SSE 重放
  router.get('/jobs/:id/events', wrap(async (req, res) => {
    const afterSeq = Number(req.query.afterSeq || 0);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (type, data) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const svc = req.app.locals.chatService;
    await svc.attachToJob({ userId: req.user.id, jobId: req.params.id, afterSeq, signal: ac.signal, emit });
    res.end();
  }));

  return router;
}

module.exports = buildRouter;
