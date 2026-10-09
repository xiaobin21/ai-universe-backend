'use strict';

/**
 * 聊天引擎（契约 §9/§10/§11/§13/§14，聊天核心单元拥有）。
 *
 *  createChatService(deps={})：
 *    deps.safeFetch  默认取 transport 的 safeFetch（测试可注入 createSafeClient({allowInsecure:true})）。
 *
 * 职责：
 *   - 对话归属/并发生成门（同会话 running/queued 即 409）
 *   - 幂等（Postgres idempotency_keys）：同键重放，绝不二次调用上游
 *   - 落库 user/assistant 消息 + parts + generation_jobs/events
 *   - 三层适配：buildRequest -> safeFetch -> parseStream；demo 路径不触网
 *   - SSE 事件（start/delta/status/usage/done/error/cancelled）逐 seq 落库并 emit + 广播
 *   - 取消（cancel_requested/acknowledged/upstream_closed）；取消仍按实产 token 计费
 *   - 上下文管理器 + 上下文长度错误压缩重试一次
 *   - 整数 micro 计费 recordUsage；demo 不记账 / cost=0
 */

const crypto = require('node:crypto');
const { query } = require('../../db/pool');
const { AppError } = require('../errors');
const { getAdapter } = require('../../adapters/registry');
const { safeFetch: defaultSafeFetch } = require('../../transport/httpClient');
const { getDecryptedCredential } = require('../credentials/credentials.service');
const { computeCostMicro, recordUsage } = require('../billing/usage');
const { estimateTokens, buildMessages, compressedMessages } = require('../context/contextManager');
const { assertTransition, isTerminal } = require('./stateMachine');
const { claimKey, attachJob, markDone, markError } = require('./idempotency');
const { runDemo } = require('./demoAdapter');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 平台环境变量映射：用户未配凭证时的兜底（契约硬要求 1）。 */
const ENV_KEY_MAP = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
  doubao: ['DOUBAO_API_KEY', 'ARK_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
};

// 进程内实时流注册表：jobId -> { controller, subscribers:Set<fn>, terminal:bool }
const liveStreams = new Map();
function broadcast(jobId, type, data) {
  const s = liveStreams.get(jobId);
  if (!s) return;
  for (const fn of s.subscribers) {
    try { fn(type, data); } catch (_) { /* 订阅者异常不影响主流程 */ }
  }
}

/** data:URL -> { mediaType, dataBase64 }；非 dataURL 返回 null。 */
function parseDataUrl(src) {
  if (typeof src !== 'string' || !src.startsWith('data:')) return null;
  const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) return null;
  return { mediaType: m[1], dataBase64: decodeURIComponent(m[3] || '') };
}

/** 入参 attachments -> 多部分 ChatPart[]。 */
function attachmentsToParts(attachments = []) {
  const parts = [];
  for (const a of attachments || []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'image') {
      if (a.src && a.src.startsWith('data:')) {
        const d = parseDataUrl(a.src);
        if (d) parts.push({ type: 'image', mediaType: d.mediaType, dataBase64: d.dataBase64 });
      } else if (a.src) {
        parts.push({ type: 'image', url: a.src });
      }
    } else if (a.type === 'doc') {
      parts.push({ type: 'attachment', name: a.name || 'doc', sizeBytes: Number(a.size) || 0, text: a.text || '' });
    } else if (a.type === 'file') {
      parts.push({ type: 'attachment', name: a.name || 'file', sizeBytes: Number(a.size) || 0 });
    }
  }
  return parts;
}

function hasImageParts(parts) {
  return parts.some((p) => p.type === 'image');
}

/**
 * undici/web ReadableStream 产出 Uint8Array；pumpSSE 按 Buffer 解码，
 * 统一包成 Buffer 异步迭代器（已是异步可迭代则原样返回）。
 */
function toBufferIterable(stream) {
  if (!stream) return stream;
  // web ReadableStream（undici）产出 Uint8Array；getReader 是 web stream 的特征，
  // Node Readable 没有 getReader。统一包成 Buffer 异步迭代器供 pumpSSE 正确解码。
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    return (async function* () {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    })();
  }
  return stream;
}

function createChatService(deps = {}) {
  const safeFetch = deps.safeFetch || defaultSafeFetch;

  // ---------------------------------------------------------------- 内部工具

  async function loadConversationForUser(conversationId, userId) {
    const r = await query(
      'SELECT * FROM conversations WHERE id=$1 AND user_id=$2 AND archived_at IS NULL',
      [conversationId, userId]
    );
    if (!r.rows.length) throw new AppError('notfound', '对话不存在或无权访问');
    return r.rows[0];
  }

  async function countActiveJobs(conversationId) {
    const r = await query(
      `SELECT count(*)::int AS n FROM generation_jobs gj
       JOIN messages m ON m.id = gj.message_id
       WHERE m.conversation_id = $1 AND gj.status IN ('queued','running')`,
      [conversationId]
    );
    return Number(r.rows[0].n || 0);
  }

  async function resolveModel(modelId) {
    const r = await query(
      `SELECT m.id AS id, m.slug AS provider_model, m.display_name AS display_name,
              p.slug AS provider, p.default_base_url AS default_base,
              p.enabled AS provider_enabled, p.circuit_open AS circuit_open,
              mc.capabilities
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         LEFT JOIN model_capabilities mc ON mc.model_id = m.id
        WHERE m.id = $1`,
      [modelId]
    );
    if (!r.rows.length) throw new AppError('badreq', '模型不存在: ' + modelId);
    return r.rows[0];
  }

  async function fallbackModelId(userId) {
    const s = await query('SELECT default_model_id FROM user_settings WHERE user_id=$1', [userId]);
    if (s.rows[0] && s.rows[0].default_model_id) return s.rows[0].default_model_id;
    const m = await query('SELECT id FROM models ORDER BY is_default DESC LIMIT 1');
    return m.rows[0] ? m.rows[0].id : null;
  }

  async function loadHistory(conversationId) {
    const r = await query(
      `SELECT m.id, m.role, m.status, m.created_at, mp.type, mp.seq, mp.content_json
         FROM messages m
         LEFT JOIN message_parts mp ON mp.message_id = m.id
        WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND m.status NOT IN ('queued','running')
        ORDER BY m.created_at ASC, mp.seq ASC`,
      [conversationId]
    );
    const byMsg = new Map();
    for (const row of r.rows) {
      if (!byMsg.has(row.id)) byMsg.set(row.id, { id: row.id, role: row.role, status: row.status, parts: [] });
      if (row.type) byMsg.get(row.id).parts.push(row.content_json);
    }
    return [...byMsg.values()];
  }

  async function resolveCredential(userId, providerSlug, defaultBase) {
    // 1) 用户加密凭证
    try {
      const cred = await getDecryptedCredential(userId, providerSlug);
      return { apiKey: cred.apiKey, baseUrl: cred.baseUrl, via: 'user' };
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'nokey')) throw e;
    }
    // 2) 平台环境变量
    const names = ENV_KEY_MAP[providerSlug] || [];
    for (const n of names) {
      if (process.env[n]) return { apiKey: process.env[n], baseUrl: defaultBase, via: 'platform' };
    }
    // 3) demo
    return null;
  }

  // ---------------------------------------------------------------- 实时事件重放

  async function attachToJob({ userId, jobId, afterSeq = 0, signal, emit }) {
    const jr = await query('SELECT * FROM generation_jobs WHERE id=$1 AND user_id=$2', [jobId, userId]);
    const job = jr.rows[0];
    if (!job) throw new AppError('notfound', '任务不存在或无权访问');

    const evts = await query(
      'SELECT seq, event_type AS type, payload_json AS data FROM generation_events WHERE job_id=$1 AND seq > $2 ORDER BY seq ASC',
      [jobId, afterSeq]
    );
    for (const e of evts.rows) emit(e.type, e.data);

    if (isTerminal(job.status)) return { status: job.status };

    const live = liveStreams.get(jobId);
    if (!live) return { status: job.status }; // 已落库但进程内无实时句柄（重启场景）
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; live.subscribers.delete(sub); resolve(); } };
      const sub = (type, data) => {
        emit(type, data);
        if (type === 'done' || type === 'error' || type === 'cancelled') finish();
      };
      live.subscribers.add(sub);
      const timer = setTimeout(finish, 5 * 60 * 1000); // 最长挂接 5 分钟
      if (signal) {
        if (signal.aborted) return finish();
        signal.addEventListener('abort', () => { clearTimeout(timer); finish(); }, { once: true });
      }
    });
    return { status: job.status };
  }

  // ---------------------------------------------------------------- 单次生成

  async function runOnce({
    userId, conversationId, userMsgId, asstMsgId, jobId, modelRow,
    messages, systemText, newUserParts, history, idemKey, reqSignal, emit,
  }) {
    const controller = new AbortController();
    if (reqSignal) {
      if (reqSignal.aborted) controller.abort();
      else reqSignal.addEventListener('abort', () => controller.abort(new AppError('cancel', '客户端断开')), { once: true });
    }
    liveStreams.set(jobId, { controller, subscribers: new Set(), terminal: false });

    let seq = 0;
    const record = async (type, data) => {
      seq += 1;
      try {
        await query(
          'INSERT INTO generation_events(id, job_id, seq, event_type, payload_json) VALUES($1,$2,$3,$4,$5)',
          [genId('evt'), jobId, seq, type, JSON.stringify(data)]
        );
      } catch (_) { /* seq 冲突忽略 */ }
      emit(type, data);
      broadcast(jobId, type, data);
    };

    const cred = await resolveCredential(userId, modelRow.provider, modelRow.default_base);
    const isDemo = !cred;

    await record('start', { jobId, userMessageId: userMsgId, assistantMessageId: asstMsgId });
    await record('status', { status: 'running' });

    let textBuf = '';
    let reasoningBuf = '';
    let usage = null;
    let cancelled = false;

    try {
      // queued -> running
      await query(`UPDATE generation_jobs SET status='running', started_at=now() WHERE id=$1`, [jobId]);

      const chatReq = {
        conversationId,
        model: {
          id: modelRow.id, provider: modelRow.provider,
          providerModel: modelRow.provider_model, displayName: modelRow.display_name,
          capabilities: modelRow.capabilities || {},
        },
        messages,
        maxOutputTokens: Math.min(
          Number(modelRow.capabilities?.maxOutputTokens) || 4096,
          Number(process.env.DEFAULT_MAX_OUTPUT_TOKENS) || 4096
        ),
        requestId: jobId,
        signal: controller.signal,
      };
      if (!isDemo) {
        chatReq.apiKey = cred.apiKey;
        chatReq.baseUrl = cred.baseUrl;
      }

      const chunks = isDemo
        ? runDemo(chatReq, controller.signal)
        : streamFromUpstream({ modelRow, chatReq });

      for await (const chunk of chunks) {
        if (controller.signal.aborted) throw new AppError('cancel', '已取消');
        switch (chunk.kind) {
          case 'textDelta':
            textBuf += chunk.text;
            await record('delta', { kind: 'text', text: chunk.text });
            break;
          case 'reasoningDelta':
            reasoningBuf += chunk.text;
            await record('delta', { kind: 'reasoning', text: chunk.text });
            break;
          case 'usage':
            usage = chunk.usage;
            await record('usage', {
              promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
              usageSource: usage.usageSource || 'upstream',
            });
            break;
          case 'error':
            throw chunk.error || new AppError('upstream', '上游流式错误');
          case 'done':
          default:
            break;
        }
      }
      cancelled = controller.signal.aborted;
    } catch (e) {
      cancelled = controller.signal.aborted || (e instanceof AppError && e.code === 'cancel');
      if (!cancelled) {
        // 真正的错误：抛出供上层做上下文压缩重试或失败落库
        throw e;
      }
    }

    // ---------------- 收尾：用量 / 计费 / 落库 ----------------
    if (!usage) {
      const promptTokens = messages.reduce((s, m) => s + (m.parts || []).reduce((x, p) => x + estimateTokens(p.text || ''), 0), 0);
      usage = { promptTokens, completionTokens: estimateTokens(textBuf + reasoningBuf), totalTokens: 0, usageSource: 'estimated' };
    }
    usage.totalTokens = usage.totalTokens || (usage.promptTokens + usage.completionTokens);

    // 写最终 parts（reasoning 在前，text 在后）
    if (reasoningBuf) {
      await query(
        'INSERT INTO message_parts(id, message_id, type, seq, content_json) VALUES($1,$2,$3,$4,$5::jsonb)',
        [genId('prt'), asstMsgId, 'reasoning', 0, JSON.stringify({ type: 'reasoning', text: reasoningBuf })]
      );
    }
    if (textBuf) {
      await query(
        'INSERT INTO message_parts(id, message_id, type, seq, content_json) VALUES($1,$2,$3,$4,$5::jsonb)',
        [genId('prt'), asstMsgId, 'text', reasoningBuf ? 1 : 0, JSON.stringify({ type: 'text', text: textBuf })]
      );
    }

    // 计费（demo 不记账 / cost=0）
    let costMicro = 0;
    let usageRecordId = null;
    if (!isDemo) {
      const cost = await computeCostMicro({
        provider: modelRow.provider, model: modelRow.provider_model,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      });
      costMicro = cost.costMicro;
      const rec = await recordUsage({
        userId, jobId, provider: modelRow.provider, model: modelRow.provider_model,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        costMicro, currency: cost.currency, usageSource: usage.usageSource,
        idempotencyKey: idemKey,
      });
      usageRecordId = rec.record.id;
    }

    if (cancelled) {
      await query(
        `UPDATE generation_jobs SET status='cancelled', finished_at=now(), usage_id=$2,
           cancel_acknowledged_at=COALESCE(cancel_acknowledged_at, now()),
           upstream_closed_at=COALESCE(upstream_closed_at, now())
         WHERE id=$1`,
        [jobId, usageRecordId]
      );
      await query(`UPDATE messages SET status='cancelled' WHERE id=$1`, [asstMsgId]);
      await record('cancelled', {
        acknowledged: true, upstreamClosed: true, costMicro,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      });
      liveStreams.delete(jobId);
      await markDone(idemKey, jobId);
      return { status: 'cancelled', costMicro, usage };
    }

    await query(
      `UPDATE generation_jobs SET status='completed', finished_at=now(), usage_id=$2 WHERE id=$1`,
      [jobId, usageRecordId]
    );
    await query(`UPDATE messages SET status='completed' WHERE id=$1`, [asstMsgId]);
    await record('done', {
      status: 'completed', costMicro,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    });
    liveStreams.delete(jobId);
    await markDone(idemKey, jobId);
    return { status: 'completed', costMicro, usage };
  }

  /** 真实供应商：buildRequest -> safeFetch -> parseStream，async generator。 */
  async function* streamFromUpstream({ modelRow, chatReq }) {
    const adapter = getAdapter(modelRow.provider);
    const built = adapter.buildRequest(chatReq);
    const resp = await safeFetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: chatReq.signal,
      requestId: chatReq.requestId,
      timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000,
      retry: false, // 流式已开始读，不重试
    });
    if (resp.status >= 400) {
      let raw = '';
      try { raw = await resp.body.text(); } catch (_) { /* 忽略 */ }
      throw adapter.mapError(resp.status, raw);
    }
    // undici/web ReadableStream 产出 Uint8Array；pumpSSE 按 Buffer 解码，
    // 这里包一层转成 Buffer 异步迭代器（修复真实供应商 SSE 解析）。
    const wrapped = toBufferIterable(resp.body);
    yield* adapter.parseStream({ ...resp, body: wrapped }, {
      signal: chatReq.signal, requestId: chatReq.requestId, providerModel: chatReq.model.providerModel,
    });
  }

  // ---------------------------------------------------------------- 对外主入口

  /**
   * 实际生成（幂等已认领之后）。insertUserMessage=false 用于「重新生成」：
   * 复用最后一条 user 消息，不重复插入 user，只新建 assistant + job（不覆盖旧消息）。
   */
  async function proceedGeneration({ userId, conversationId, text, attachments = [], idemKey, signal, emit, insertUserMessage = true }) {
    const conv = await loadConversationForUser(conversationId, userId);

    // 模型解析
    const modelId = conv.model_id || (await fallbackModelId(userId));
    if (!modelId) throw new AppError('badreq', '请先选择一个模型');
    const modelRow = await resolveModel(modelId);
    if (modelRow.provider_enabled === false || modelRow.circuit_open === true) {
      throw new AppError('conflict', `供应商 ${modelRow.provider} 当前不可用（熔断或停用）`);
    }

    // 历史 + 上下文裁剪（在插入新消息之前取旧历史）
    const history = await loadHistory(conversationId);
    const userParts = [{ type: 'text', text: String(text || '') }];
    const extraParts = attachmentsToParts(attachments);
    const allUserParts = [...userParts, ...extraParts];

    // 落库：assistant 占位 + generation_job
    const asstMsgId = genId('msg');
    const jobId = genId('job');
    const requestId = crypto.randomUUID();

    let userMsgId = null;
    if (insertUserMessage) {
      userMsgId = genId('msg');
      const lastMsg = history[history.length - 1];
      await query(
        `INSERT INTO messages(id, conversation_id, role, parent_message_id, status) VALUES($1,$2,'user',$3,'completed')`,
        [userMsgId, conversationId, lastMsg ? lastMsg.id : null]
      );
      await query(
        'INSERT INTO message_parts(id, message_id, type, seq, content_json) VALUES($1,$2,$3,0,$4::jsonb)',
        [genId('prt'), userMsgId, 'text', JSON.stringify({ type: 'text', text: String(text || '') })]
      );
      for (const a of extraParts) {
        await query(
          'INSERT INTO message_parts(id, message_id, type, seq, content_json) VALUES($1,$2,$3,1,$4::jsonb)',
          [genId('prt'), userMsgId, a.type, JSON.stringify(a)]
        );
      }
    } else {
      // 重新生成：parent 指向最后一条 user 消息
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      userMsgId = lastUser ? lastUser.id : null;
    }

    await query(
      `INSERT INTO messages(id, conversation_id, role, parent_message_id, status, job_id)
       VALUES($1,$2,'assistant',$3,'queued',$4)`,
      [asstMsgId, conversationId, userMsgId, jobId]
    );
    await query(
      `INSERT INTO generation_jobs(id, message_id, user_id, provider, model, status, request_id, idempotency_key)
       VALUES($1,$2,$3,$4,$5,'queued',$6,$7)`,
      [jobId, asstMsgId, userId, modelRow.provider, modelRow.provider_model, requestId, idemKey]
    );
    await attachJob(idemKey, jobId);

    // 上下文构建（首次）
    let ctx = buildMessages({ history, newUserParts: allUserParts, capabilities: modelRow.capabilities || {} });
    let messages = ctx.messages;

    const runArgs = {
      userId, conversationId, userMsgId, asstMsgId, jobId, modelRow,
      newUserParts: allUserParts, history, idemKey, reqSignal: signal, emit,
    };

    try {
      await assertTransition('queued', 'running');
      await query(`UPDATE messages SET status='running' WHERE id=$1`, [asstMsgId]);
      const result = await runOnce({ ...runArgs, messages });
      await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]);
      return result;
    } catch (e) {
      // 上下文长度错误 -> 压缩重试一次（仅一次）
      const isCtxErr = e instanceof AppError && e.code === 'badreq' && /context|length|too many|token/i.test(e.message);
      if (isCtxErr) {
        ctx = compressedMessages({ history, newUserParts: allUserParts });
        try {
          const result = await runOnce({ ...runArgs, messages: ctx.messages });
          await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]);
          return result;
        } catch (e2) {
          return await failJob({ jobId, asstMsgId, idemKey, emit, err: e2 });
        }
      }
      return await failJob({ jobId, asstMsgId, idemKey, emit, err: e });
    }
  }

  /** 用户发消息。 */
  async function handleUserMessage({ userId, conversationId, text, attachments = [], idemKey, signal, emit }) {
    const conversationIdOk = conversationId;
    await loadConversationForUser(conversationIdOk, userId); // 归属校验
    if (await countActiveJobs(conversationIdOk) > 0) {
      throw new AppError('conflict', '该对话正在生成中，请等待完成或先取消当前任务');
    }
    const idem = await claimKey({ key: idemKey, userId, scope: 'chat' });
    if (idem.outcome === 'replay_running' || idem.outcome === 'replay_done') {
      await attachToJob({ userId, jobId: idem.jobId, afterSeq: 0, signal, emit });
      return { idempotentReplay: true, jobId: idem.jobId };
    }
    return proceedGeneration({ userId, conversationId, text, attachments, idemKey, signal, emit, insertUserMessage: true });
  }

  /** 重新生成：不重复插 user，新建 assistant + job，不覆盖旧消息。 */
  async function handleRegenerate({ userId, conversationId, signal, emit }) {
    await loadConversationForUser(conversationId, userId);
    if (await countActiveJobs(conversationId) > 0) {
      throw new AppError('conflict', '该对话正在生成中，请等待完成或先取消当前任务');
    }
    // 取最后一条 user 消息文本
    const hist = await loadHistory(conversationId);
    const lastUser = [...hist].reverse().find((m) => m.role === 'user');
    const text = lastUser ? (lastUser.parts.find((p) => p.type === 'text') || {}).text || '' : '';
    const idemKey = 'regen_' + crypto.randomUUID();
    return proceedGeneration({ userId, conversationId, text, attachments: [], idemKey, signal, emit, insertUserMessage: false });
  }

  async function failJob({ jobId, asstMsgId, idemKey, emit, err }) {
    const e = err instanceof AppError ? err : new AppError('internal', String((err && err.message) || err));
    liveStreams.delete(jobId);
    await query(
      `UPDATE generation_jobs SET status='failed', finished_at=now(), error_code=$2, error_message=$3 WHERE id=$1`,
      [jobId, e.code, e.message]
    ).catch(() => {});
    await query(`UPDATE messages SET status='failed' WHERE id=$1`, [asstMsgId]).catch(() => {});
    await markError(idemKey, jobId).catch(() => {});
    try {
      await emit('error', { code: e.code, message: e.message, retryable: !!e.retryable });
    } catch (_) { /* emit 已不可用 */ }
    return { status: 'failed', error: e };
  }

  // ---------------------------------------------------------------- 取消 / 查询

  async function cancelJob({ userId, jobId }) {
    const r = await query(
      `UPDATE generation_jobs SET cancel_requested_at=COALESCE(cancel_requested_at, now())
       WHERE id=$1 AND user_id=$2 AND status IN ('queued','running')
       RETURNING id, status, cancel_requested_at AS "cancelRequestedAt"`,
      [jobId, userId]
    );
    if (!r.rows.length) {
      // 查是否已结束
      const any = await query('SELECT id FROM generation_jobs WHERE id=$1 AND user_id=$2', [jobId, userId]);
      if (!any.rows.length) throw new AppError('notfound', '任务不存在');
      const cur = await query('SELECT status FROM generation_jobs WHERE id=$1', [jobId]);
      return { status: cur.rows[0].status, cancelRequestedAt: null, alreadyEnded: true };
    }
    const live = liveStreams.get(jobId);
    if (live) live.controller.abort(new AppError('cancel', '用户请求取消'));
    return { status: r.rows[0].status, cancelRequestedAt: r.rows[0].cancelRequestedAt };
  }

  async function getJob({ userId, jobId }) {
    const r = await query(
      `SELECT id, status, provider, model, request_id AS "requestId",
              cancel_requested_at AS "cancelRequestedAt",
              cancel_acknowledged_at AS "cancelAcknowledgedAt",
              upstream_closed_at AS "upstreamClosedAt",
              error_code AS "errorCode", error_message AS "errorMessage",
              usage_id AS "usageId", started_at AS "startedAt", finished_at AS "finishedAt"
         FROM generation_jobs WHERE id=$1 AND user_id=$2`,
      [jobId, userId]
    );
    if (!r.rows.length) throw new AppError('notfound', '任务不存在');
    const job = r.rows[0];
    let usage = null;
    if (job.usageId) {
      const u = await query(
        `SELECT prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
                cost_micro AS "costMicro", usage_source AS "usageSource"
           FROM usage_records WHERE id=$1`,
        [job.usageId]
      );
      usage = u.rows[0] || null;
    }
    return { job, usage };
  }

  return {
    handleUserMessage,
    handleRegenerate,
    attachToJob,
    cancelJob,
    getJob,
    // 暴露给测试/路由的内部工具
    _liveStreams: liveStreams,
  };
};

module.exports = { createChatService };
