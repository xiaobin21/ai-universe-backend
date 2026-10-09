'use strict';

/**
 * 对话路由（契约 §8.4，前缀 /api/conversations，全部需登录）。
 *  - GET /            -> 裸数组 [{id,title,modelId,updatedAt,lastSnippet}]
 *  - POST /           -> {conversation}
 *  - GET /:id         -> {conversation, messages:[{id,role,status,parts,usage,createdAt,jobId}]}
 *  - PATCH /:id       -> {title?, modelId?}
 *  - DELETE /:id      -> 软删除（archived_at）
 *  - POST /:id/messages      -> SSE（Idempotency-Key 头）
 *  - POST /:id/regenerate    -> SSE
 */

const express = require('express');
const crypto = require('node:crypto');
const { query } = require('../db/pool');
const { AppError } = require('../core/errors');
const { requireAuth } = require('../core/auth/middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 惰性 SSE：首个事件才写 SSE 头，保证前置 4xx 仍走 JSON 错误中间件。 */
function makeEmit(res) {
  let started = false;
  return (type, data) => {
    if (!started) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      started = true;
    }
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

/** 把 messages 行按 message 聚合为 {conversation, messages}。 */
async function loadConversationDetail(conversationId, userId) {
  const c = await query(
    `SELECT id, title, model_id AS "modelId", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM conversations WHERE id=$1 AND user_id=$2 AND archived_at IS NULL`,
    [conversationId, userId]
  );
  if (!c.rows.length) throw new AppError('notfound', '对话不存在');
  const conversation = c.rows[0];

  const m = await query(
    `SELECT m.id, m.role, m.status, m.job_id AS "jobId", m.created_at AS "createdAt",
            mp.type, mp.seq, mp.content_json
       FROM messages m
       LEFT JOIN message_parts mp ON mp.message_id = m.id
      WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC, mp.seq ASC`,
    [conversationId]
  );
  const byId = new Map();
  for (const row of m.rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, { id: row.id, role: row.role, status: row.status, jobId: row.jobId, createdAt: row.createdAt, parts: [], usage: null });
    }
    if (row.type) byId.get(row.id).parts.push(row.content_json);
  }
  // 关联 usage（含 costMicro）
  const msgIds = [...byId.keys()];
  let usageByMsg = new Map();
  if (msgIds.length) {
    const u = await query(
      `SELECT gj.message_id AS "messageId", ur.prompt_tokens AS "promptTokens",
              ur.completion_tokens AS "completionTokens", ur.cost_micro AS "costMicro",
              ur.usage_source AS "usageSource"
         FROM generation_jobs gj JOIN usage_records ur ON ur.id = gj.usage_id
        WHERE gj.message_id = ANY($1)`,
      [msgIds]
    );
    for (const row of u.rows) usageByMsg.set(row.messageId, {
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      costMicro: Number(row.costMicro),
      usageSource: row.usageSource,
    });
  }
  const messages = [...byId.values()].map((msg) => ({ ...msg, usage: usageByMsg.get(msg.id) || null }));
  return { conversation, messages };
}

function buildRouter() {
  const router = express.Router();
  router.use(requireAuth);

  // GET /api/conversations -> 裸数组
  router.get('/', wrap(async (req, res) => {
    const r = await query(
      `SELECT c.id, c.title, c.model_id AS "modelId", c.updated_at AS "updatedAt",
              (SELECT mp.content_json->>'text' FROM messages m
                 JOIN message_parts mp ON mp.message_id=m.id AND mp.type='text'
                WHERE m.conversation_id=c.id AND m.role='user' AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1) AS "lastSnippet"
         FROM conversations c
        WHERE c.user_id=$1 AND c.archived_at IS NULL
        ORDER BY c.updated_at DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  }));

  // POST /api/conversations {title?, modelId?}
  router.post('/', wrap(async (req, res) => {
    const title = (req.body && req.body.title) || '新对话';
    let modelId = req.body && req.body.modelId ? String(req.body.modelId) : null;
    // 未指定模型时，固化为后端默认模型，避免「前端显示首项 / 生成用 is_default」口径不一致
    if (!modelId) {
      const s = await query('SELECT default_model_id FROM user_settings WHERE user_id=$1', [req.user.id]);
      if (s.rows[0] && s.rows[0].default_model_id) modelId = s.rows[0].default_model_id;
      else {
        const d = await query('SELECT id FROM models ORDER BY is_default DESC, id LIMIT 1');
        modelId = d.rows[0] && d.rows[0].id;
      }
    }
    const id = 'cvs_' + crypto.randomBytes(12).toString('hex');
    const r = await query(
      `INSERT INTO conversations(id, user_id, title, model_id) VALUES($1,$2,$3,$4)
       RETURNING id, title, model_id AS "modelId", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, req.user.id, title, modelId]
    );
    res.status(201).json(r.rows[0]);
  }));

  // GET /api/conversations/:id
  router.get('/:id', wrap(async (req, res) => {
    const out = await loadConversationDetail(req.params.id, req.user.id);
    res.json(out);
  }));

  // PATCH /api/conversations/:id
  router.patch('/:id', wrap(async (req, res) => {
    const { title, modelId } = req.body || {};
    // modelId 仅在非生成中可改
    if (modelId !== undefined) {
      const busy = await query(
        `SELECT 1 FROM generation_jobs gj JOIN messages m ON m.id=gj.message_id
          WHERE m.conversation_id=$1 AND gj.status IN ('queued','running') LIMIT 1`,
        [req.params.id]
      );
      if (busy.rows.length) throw new AppError('conflict', '对话正在生成中，暂不能切换模型');
    }
    await query(
      `UPDATE conversations SET title=COALESCE($3,title), model_id=COALESCE($4, model_id), updated_at=now()
        WHERE id=$1 AND user_id=$2 AND archived_at IS NULL`,
      [req.params.id, req.user.id, title ?? null, modelId ?? null]
    );
    const out = await loadConversationDetail(req.params.id, req.user.id);
    res.json(out);
  }));

  // DELETE /api/conversations/:id -> 软删除
  router.delete('/:id', wrap(async (req, res) => {
    await query(
      `UPDATE conversations SET archived_at=now() WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.status(204).end();
  }));

  // POST /api/conversations/:id/messages -> SSE
  router.post('/:id/messages', wrap(async (req, res) => {
    const idemKey = req.headers['idempotency-key'];
    if (!idemKey) throw new AppError('badreq', '缺少 Idempotency-Key 头');
    const text = (req.body && req.body.text) || '';
    const attachments = (req.body && req.body.attachments) || [];
    const emit = makeEmit(res);
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(new AppError('cancel', '客户端断开')); });

    const svc = req.app.locals.chatService;
    await svc.handleUserMessage({
      userId: req.user.id, conversationId: req.params.id,
      text, attachments, idemKey: String(idemKey), signal: ac.signal, emit,
    });
    res.end();
  }));

  // POST /api/conversations/:id/regenerate -> SSE
  router.post('/:id/regenerate', wrap(async (req, res) => {
    const emit = makeEmit(res);
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(new AppError('cancel', '客户端断开')); });
    const svc = req.app.locals.chatService;
    await svc.handleRegenerate({ userId: req.user.id, conversationId: req.params.id, signal: ac.signal, emit });
    res.end();
  }));

  return router;
}

module.exports = buildRouter;
module.exports.loadConversationDetail = loadConversationDetail;
