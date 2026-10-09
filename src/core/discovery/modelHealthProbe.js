'use strict';

/**
 * ModelHealthProbe —— 自动停用探测（契约 §5）。
 *
 * 仅对有凭证的供应商、对 active 模型发最小无害请求（"hi", max_tokens=1, stream 关闭）。
 * 只有明确「模型退役/不存在」信号才置 deprecated：
 *   - HTTP 404；或
 *   - HTTP 400 且错误 code/文案命中退役关键词（大小写不敏感）。
 * 其余（401/403/402/429/网络/5xx/超时/无法判定的 400）一律保持 active，仅更新 last_checked_at。
 * 停用可逆；探测用平台/管理员 key，不向普通用户计费、不写用户用量。
 */

const { config, getPlatformKey, getPlatformBaseUrl } = require('../../config');
const { query } = require('../../db/pool');
const { getAdapter } = require('../../adapters/registry');
const { getDecryptedCredential } = require('../credentials/credentials.service');
const { safeFetch } = require('../../transport/httpClient');

const API_VERSION = '2023-06-01';
const RETIRE_RE = /model_not_found|does not exist|not found|deprecated|decommissioned|已下线|不存在|已停用/i;

async function readText(res) {
  try {
    if (res && res.raw && typeof res.raw.text === 'function') return await res.raw.text();
  } catch { /* ignore */ }
  return '';
}

/**
 * 纯函数：把一次探测的 HTTP 结果分类为 deprecated / keptActive。
 * 提取 400 错误体里的 code 与 message 一起参与退役关键词匹配。
 */
function classifyProbeResponse({ status, text }) {
  if (status === 404) {
    return { outcome: 'deprecated', reason: '探测判定退役: HTTP 404 模型不存在' };
  }
  if (status === 400) {
    let blob = text || '';
    try {
      const j = JSON.parse(text || '');
      const e = j && (j.error || j);
      blob = [e && e.code, e && e.message, j && j.statusMessage].filter(Boolean).join(' ');
    } catch { /* 非 JSON，直接用原文 */ }
    if (RETIRE_RE.test(blob)) {
      return { outcome: 'deprecated', reason: `探测判定退役: ${String(blob).slice(0, 200)}` };
    }
    return { outcome: 'keptActive', reason: '400 但非退役信号' };
  }
  return { outcome: 'keptActive', reason: `HTTP ${status}` };
}

/** 构造最小探测请求（不改动适配器既有 buildRequest 的流式逻辑）。 */
function buildProbeRequest(provider, { apiKey, baseUrl, providerModel }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (provider === 'gemini') {
    return {
      url: `${base}/v1beta/models/${encodeURIComponent(providerModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      },
    };
  }
  if (provider === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: { model: providerModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    };
  }
  // OpenAI 兼容系
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: { model: providerModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
  };
}

/**
 * @param {object} [deps] 可注入：query/getAdapter/getDecryptedCredential/getPlatformKey/
 *                        getPlatformBaseUrl/config/transport（safeFetch 形态）。
 */
function createModelHealthProbe(deps = {}) {
  const dbQuery = deps.query || query;
  const adapters = deps.getAdapter || getAdapter;
  const decryptCred = deps.getDecryptedCredential || getDecryptedCredential;
  const platformKey = deps.getPlatformKey || getPlatformKey;
  const platformBase = deps.getPlatformBaseUrl || getPlatformBaseUrl;
  const transport = deps.transport || safeFetch;
  const cfg = deps.config || config;

  let lastRun = null;

  async function resolveCredential(provider, { trigger, adminUserId }) {
    if (trigger === 'manual' && adminUserId) {
      try {
        const cred = await decryptCred(adminUserId, provider);
        if (cred && cred.apiKey) return { apiKey: cred.apiKey, baseUrl: cred.baseUrl || null };
      } catch { /* fall through */ }
    }
    const pk = platformKey(provider);
    if (pk) return { apiKey: pk, baseUrl: platformBase(provider) || null };
    return { apiKey: null, baseUrl: null };
  }

  /** 并发受限地执行一批任务。 */
  async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let idx = 0;
    async function loop() {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await worker(items[my], my);
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, () => loop()));
    return results;
  }

  /**
   * @param {{trigger?:'manual'|'startup', adminUserId?:string, timeoutMs?:number}} [opts]
   */
  async function run({ trigger = 'manual', adminUserId = null, timeoutMs = 15000 } = {}) {
    const ranAt = new Date().toISOString();
    const rows = await dbQuery(
      `SELECT m.id, p.slug AS provider, m.slug AS "providerModel",
              p.default_base_url AS "defaultBaseUrl"
         FROM models m JOIN providers p ON p.id = m.provider_id
        WHERE m.lifecycle = 'active'`
    );
    const models = rows.rows;

    // 按供应商分组，便于每供应商只解析一次凭证
    const byProvider = new Map();
    for (const r of models) {
      if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
      byProvider.get(r.provider).push(r);
    }

    const outcomes = {};
    const totals = { checked: 0, deprecated: 0, keptActive: 0, errors: 0 };
    const concurrency = Math.max(1, cfg.modelProbeConcurrency);

    for (const [provider, list] of byProvider) {
      const cred = await resolveCredential(provider, { trigger, adminUserId });
      if (!cred.apiKey) continue; // 无凭证的供应商整体跳过

      await runWithConcurrency(list, concurrency, async (m) => {
        totals.checked += 1;
        try {
          // base 优先级：凭证自定义 base > 平台 base > providers.default_base_url
          const base = cred.baseUrl || m.defaultBaseUrl;
          if (!base) {
            outcomes[m.id] = { outcome: 'error', httpStatus: null, reason: '无 base_url' };
            totals.errors += 1;
            return;
          }
          const reqObj = buildProbeRequest(provider, { apiKey: cred.apiKey, baseUrl: base, providerModel: m.providerModel });
          const res = await transport(reqObj.url, {
            method: 'POST',
            headers: reqObj.headers,
            body: JSON.stringify(reqObj.body),
            timeoutMs,
            retry: false,
          });
          const text = await readText(res);
          const { outcome, reason } = classifyProbeResponse({ status: res.status, text });
          if (outcome === 'deprecated') {
            await dbQuery(
              `UPDATE models SET lifecycle='deprecated', deprecation_reason=$2, last_checked_at=now() WHERE id=$1`,
              [m.id, reason]
            );
            totals.deprecated += 1;
          } else {
            await dbQuery(`UPDATE models SET last_checked_at=now() WHERE id=$1`, [m.id]);
            totals.keptActive += 1;
          }
          outcomes[m.id] = { outcome, httpStatus: res.status, reason };
        } catch (e) {
          // 网络/超时/取消：保持 active，仅记录
          await dbQuery(`UPDATE models SET last_checked_at=now() WHERE id=$1`, [m.id]).catch(() => {});
          outcomes[m.id] = { outcome: 'error', httpStatus: null, reason: String((e && e.message) || e) };
          totals.errors += 1;
        }
      });
    }

    const result = { ranAt, trigger, models: outcomes, totals };
    lastRun = result;
    return result;
  }

  function getLastRun() { return lastRun; }

  return { run, getLastRun, classifyProbeResponse, buildProbeRequest };
}

let _singleton = null;
function defaultModelHealthProbe() {
  if (!_singleton) _singleton = createModelHealthProbe({});
  return _singleton;
}

module.exports = { createModelHealthProbe, defaultModelHealthProbe, classifyProbeResponse, buildProbeRequest };
