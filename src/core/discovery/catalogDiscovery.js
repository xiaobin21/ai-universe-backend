'use strict';

/**
 * CatalogDiscovery —— 动态模型目录自动发现（契约 §4）。
 *
 * 凭证隐私边界：
 *   - 手动（管理员触发）：优先该管理员已保存的解密凭证，其次平台共享 key，都没有则跳过该供应商。
 *   - 启动 / interval / cron：只用平台 key（getPlatformKey），绝不读取任何普通用户凭证。
 *
 * Diff 规则（逐供应商，错误隔离）：
 *   - 新 id -> 插入 discovered 行（保守能力，无价格）；
 *   - 已存在 -> 更新 last_seen_at、miss_count=0；若此前 deprecated 且本次出现则回 active；
 *   - seeded/manual 本次未列出 -> 不停用、不增 miss；
 *   - discovered 本次未列出 -> miss_count+=1，达阈值才 deprecated；
 *   - 幂等：重复运行不产生重复行、不越界计数。
 */

const crypto = require('node:crypto');
const { config, getPlatformKey, getPlatformBaseUrl } = require('../../config');
const { query } = require('../../db/pool');
const { listAdapters, getAdapter } = require('../../adapters/registry');
const { getDecryptedCredential } = require('../credentials/credentials.service');

/** discovered 模型的保守默认能力（契约 §3）。绝不臆测 vision/thinking 为 true；不写价格。 */
function conservativeCapabilities(provider) {
  if (provider === 'gemini') {
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
      supportsSystemPrompt: true,
      supportsThinking: false,
      supportsStructuredOutput: false,
      contextWindow: 32768,
      maxOutputTokens: 4096,
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCallFormat: 'gemini',
      conservativeDefaults: true,
    };
  }
  // OpenAI 兼容系
  return {
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsSystemPrompt: true,
    supportsThinking: false,
    supportsStructuredOutput: true,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    inputModalities: ['text'],
    outputModalities: ['text'],
    toolCallFormat: 'openai',
    conservativeDefaults: true,
  };
}

/** 全局唯一且稳定的 discovered 模型 id。 */
function discoveredModelId(provider, slug) {
  const h = crypto.createHash('sha256').update(`${provider}:${slug}`).digest('hex').slice(0, 16);
  return `mdl_disc_${provider}_${h}`;
}

async function getProviderRow(slug) {
  const r = await query('SELECT id, slug FROM providers WHERE slug = $1', [slug]);
  return r.rows[0] || null;
}

/**
 * @param {object} [deps] 可注入用于测试：query/getAdapter/listAdapters/getDecryptedCredential
 *                        /getPlatformKey/getPlatformBaseUrl/config。
 */
function createCatalogDiscovery(deps = {}) {
  const dbQuery = deps.query || query;
  const adapters = deps.getAdapter || getAdapter;
  const providerList = deps.listAdapters || listAdapters;
  const decryptCred = deps.getDecryptedCredential || getDecryptedCredential;
  const platformKey = deps.getPlatformKey || getPlatformKey;
  const platformBase = deps.getPlatformBaseUrl || getPlatformBaseUrl;
  const cfg = deps.config || config;

  let lastRun = null;

  async function resolveCredential(provider, { trigger, adminUserId } = {}) {
    // 手动触发才可能读取该管理员已保存凭证；其它触发只用平台 key
    if (trigger === 'manual' && adminUserId) {
      try {
        const cred = await decryptCred(adminUserId, provider);
        if (cred && cred.apiKey) {
          return { apiKey: cred.apiKey, baseUrl: cred.baseUrl || null, userCredential: true };
        }
      } catch { /* 无该管理员凭证 -> 落到平台 key */ }
    }
    const pk = platformKey(provider);
    if (pk) return { apiKey: pk, baseUrl: platformBase(provider) || null, userCredential: false };
    return { apiKey: null, baseUrl: null, userCredential: false };
  }

  async function syncProvider(provider, { trigger, adminUserId, timeoutMs, signal, threshold }) {
    const stat = {
      queried: false, supported: false, seen: 0, added: 0,
      updated: 0, markedDeprecated: 0, skipped: false, skipReason: null, error: null,
    };
    let adapter;
    try {
      adapter = adapters(provider);
    } catch (e) {
      stat.skipped = true; stat.skipReason = 'no_adapter'; stat.error = String(e && e.message || e);
      return stat;
    }

    const cred = await resolveCredential(provider, { trigger, adminUserId });
    if (!cred.apiKey) {
      stat.skipped = true; stat.skipReason = 'no_credential';
      return stat;
    }

    stat.queried = true;
    let listRes;
    try {
      listRes = await adapter.listModels({
        apiKey: cred.apiKey, baseUrl: cred.baseUrl || undefined,
        timeoutMs, signal,
      });
    } catch (e) {
      // 单供应商失败不影响其它供应商
      stat.error = String((e && e.message) || e);
      stat.skipped = true; stat.skipReason = 'error';
      return stat;
    }

    if (!listRes || listRes.supported !== true) {
      stat.supported = false;
      stat.skipped = true;
      stat.skipReason = (listRes && listRes.reason) || 'unsupported';
      return stat;
    }

    stat.supported = true;
    const upstreamIds = Array.from(new Set((listRes.models || []).map((s) => String(s).trim()).filter(Boolean)));
    stat.seen = upstreamIds.length;

    const prov = await getProviderRow(provider);
    if (!prov) { stat.skipped = true; stat.skipReason = 'unknown_provider'; return stat; }

    // 现有该供应商全部模型
    const existing = await dbQuery(
      `SELECT id, slug, source, lifecycle, miss_count AS "missCount"
         FROM models WHERE provider_id = $1`,
      [prov.id]
    );
    const bySlug = new Map();
    for (const row of existing.rows) bySlug.set(row.slug, row);

    const upstreamSet = new Set(upstreamIds);

    // 1) 处理上游列出的 id：新增或更新
    for (const slug of upstreamIds) {
      const row = bySlug.get(slug);
      if (!row) {
        // 新增 discovered 行（无价格）
        const newId = discoveredModelId(provider, slug);
        await dbQuery(
          `INSERT INTO models(id, provider_id, slug, display_name, is_default,
                              source, lifecycle, capabilities_verified, miss_count,
                              first_seen_at, last_seen_at)
             VALUES($1,$2,$3,$4,false,'discovered','active',false,0,now(),now())
             ON CONFLICT (slug) DO NOTHING`,
          [newId, prov.id, slug, slug]
        );
        const ins = await dbQuery('SELECT id FROM models WHERE slug=$1 AND provider_id=$2', [slug, prov.id]);
        const insertedId = ins.rows[0] && ins.rows[0].id;
        if (insertedId) {
          await dbQuery(
            `INSERT INTO model_capabilities(id, model_id, capabilities)
             VALUES($1,$2,$3::jsonb) ON CONFLICT (model_id) DO NOTHING`,
            [`cap_${insertedId}`, insertedId, JSON.stringify(conservativeCapabilities(provider))]
          );
          stat.added += 1;
        }
      } else {
        // 已存在：更新 last_seen、清零 miss；此前误判 deprecated 则回 active
        const revive = row.lifecycle === 'deprecated' ? ", lifecycle='active', deprecation_reason=NULL" : '';
        await dbQuery(
          `UPDATE models SET last_seen_at=now(), miss_count=0${revive} WHERE id=$1`,
          [row.id]
        );
        stat.updated += 1;
      }
    }

    // 2) 处理本次未列出的既有模型
    for (const row of existing.rows) {
      if (upstreamSet.has(row.slug)) continue;
      if (row.source === 'seeded' || row.source === 'manual') {
        // 人工策展：不被接口波动影响，不停用、不增 miss
        continue;
      }
      // discovered 模型：连续未列出累计 miss；达阈值才 deprecated
      if (row.lifecycle === 'deprecated') continue; // 已停用，保持幂等不重复处理
      const nextMiss = Number(row.missCount || 0) + 1;
      if (nextMiss >= threshold) {
        await dbQuery(
          `UPDATE models SET miss_count=$2, lifecycle='deprecated',
             deprecation_reason=$3 WHERE id=$1`,
          [row.id, nextMiss, `连续 ${threshold} 次同步未列出`]
        );
        stat.markedDeprecated += 1;
      } else {
        await dbQuery(`UPDATE models SET miss_count=$2 WHERE id=$1`, [row.id, nextMiss]);
      }
    }

    return stat;
  }

  /**
   * 跑一次完整发现。
   * @param {{trigger?:'startup'|'interval'|'manual'|'cron', adminUserId?:string,
   *          timeoutMs?:number, signal?:AbortSignal}} [opts]
   */
  async function run({ trigger = 'manual', adminUserId = null, timeoutMs, signal } = {}) {
    const started = Date.now();
    const ranAt = new Date().toISOString();
    const tmo = timeoutMs || cfg.discoveryTimeoutMs;
    const threshold = Math.max(1, cfg.discoveryDeprecateAfterMisses);
    const providers = providerList();

    const result = { ranAt, trigger, durationMs: 0, providers: {}, totals: { providers: providers.length, queried: 0, added: 0, seen: 0, markedDeprecated: 0, skipped: 0 } };

    for (const provider of providers) {
      try {
        const stat = await syncProvider(provider, { trigger, adminUserId, timeoutMs: tmo, signal, threshold });
        result.providers[provider] = stat;
        if (stat.queried) result.totals.queried += 1;
        result.totals.added += stat.added;
        result.totals.seen += stat.seen;
        result.totals.markedDeprecated += stat.markedDeprecated;
        if (stat.skipped) result.totals.skipped += 1;
      } catch (e) {
        // 单供应商兜底（理论上 syncProvider 已隔离，这里再兜一层保证整次不挂）
        result.providers[provider] = {
          queried: false, supported: false, seen: 0, added: 0, updated: 0,
          markedDeprecated: 0, skipped: true, skipReason: 'error',
          error: String((e && e.message) || e),
        };
        result.totals.skipped += 1;
      }
    }

    result.durationMs = Date.now() - started;
    lastRun = result;
    return result;
  }

  function getLastRun() { return lastRun; }

  return { run, getLastRun };
}

// 进程内单例（status 接口读取；测试请用 createCatalogDiscovery 注入 deps）
let _singleton = null;
function defaultCatalogDiscovery() {
  if (!_singleton) _singleton = createCatalogDiscovery({});
  return _singleton;
}

module.exports = { createCatalogDiscovery, defaultCatalogDiscovery, conservativeCapabilities, discoveredModelId };
