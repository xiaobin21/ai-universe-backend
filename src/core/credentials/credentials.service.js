'use strict';

/**
 * 供应商凭证服务（契约 §4 / §8.3）。
 *
 *  - API Key 用 AES-256-GCM 加密入库（encryptSecret），DB 只存密文 + masked_hint。
 *  - 列表/响应绝不回显完整 key，只给前4后4（maskSecret）。
 *  - 重输直接覆盖，不回填旧值；删除立即作废。
 *  - 连通性测试走 safeFetch（自带 SSRF 守卫），5s 超时、不重试、不带内部凭据。
 */

const crypto = require('node:crypto');
const { query } = require('../../db/pool');
const { config } = require('../../config');
const { AppError } = require('../errors');
const { encryptSecret, decryptSecret, maskSecret } = require('../security/crypto');
const { assertUrlAllowed } = require('../security/ssrf');
const { safeFetch } = require('../../transport/httpClient');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

async function audit({ userId, action, ip, meta }) {
  try {
    await query(
      'INSERT INTO audit_logs(id, user_id, action, ip, meta_json) VALUES($1,$2,$3,$4,$5)',
      [genId('aud'), userId || null, action, ip || null, JSON.stringify(meta || {})]
    );
  } catch (e) {
    console.error('[audit] 写入失败:', action, e && e.message);
  }
}

async function getProviderBySlug(slug) {
  const r = await query(
    'SELECT id, slug, name, kind, default_base_url AS "defaultBaseUrl" FROM providers WHERE slug = $1',
    [slug]
  );
  return r.rows[0] || null;
}

/**
 * 列出某用户已配置的所有供应商凭证（含未配置的供应商，configured=false）。
 * 绝不返回完整 key。
 */
async function listForUser(userId) {
  const r = await query(
    `SELECT p.slug AS provider,
            pc.base_url AS "baseUrl",
            pc.masked_hint AS "maskedHint",
            (pc.encrypted_credentials IS NOT NULL) AS configured
     FROM providers p
     LEFT JOIN provider_credentials pc ON pc.provider_id = p.id AND pc.user_id = $1
     ORDER BY p.slug`,
    [userId]
  );
  return r.rows.map((row) => ({
    provider: row.provider,
    baseUrl: row.baseUrl || null,
    maskedHint: row.maskedHint || null,
    configured: row.configured === true || row.configured === 't',
  }));
}

/**
 * 保存/覆盖凭证。
 * @param {{userId:string, providerSlug:string, apiKey:string, baseUrl?:string|null, ip?:string}} input
 */
async function upsert({ userId, providerSlug, apiKey, baseUrl, ip } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new AppError('badreq', 'apiKey 不能为空');
  }
  const provider = await getProviderBySlug(providerSlug);
  if (!provider) throw new AppError('notfound', `未知供应商: ${providerSlug}`);

  // baseUrl：用户自定义时走 SSRF 静态校验（域名由 safeFetch 在连接时再校验）
  let finalBaseUrl = null;
  if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
    assertUrlAllowed(baseUrl.trim(), { allowInsecure: config.allowInsecureLocalMode });
    finalBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  const key = apiKey.trim();
  const encrypted = encryptSecret(key);
  const maskedHint = maskSecret(key);

  await query(
    `INSERT INTO provider_credentials(id, user_id, provider_id, encrypted_credentials, masked_hint, base_url)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, provider_id) DO UPDATE SET
       encrypted_credentials = EXCLUDED.encrypted_credentials,
       masked_hint = EXCLUDED.masked_hint,
       base_url = COALESCE(EXCLUDED.base_url, provider_credentials.base_url),
       rotated_at = now()`,
    [genId('crd'), userId, provider.id, encrypted, maskedHint, finalBaseUrl]
  );
  await audit({ userId, action: 'credential.upsert', ip, meta: { provider: providerSlug } });
  return { provider: providerSlug, maskedHint };
}

/** 删除凭证（立即作废）。 */
async function remove({ userId, providerSlug, ip } = {}) {
  const provider = await getProviderBySlug(providerSlug);
  if (!provider) throw new AppError('notfound', `未知供应商: ${providerSlug}`);
  const r = await query(
    'DELETE FROM provider_credentials WHERE user_id = $1 AND provider_id = $2',
    [userId, provider.id]
  );
  await audit({
    userId,
    action: 'credential.delete',
    ip,
    meta: { provider: providerSlug, existed: r.rowCount > 0 },
  });
  return { provider: providerSlug, existed: r.rowCount > 0 };
}

/**
 * 供聊天核心使用：取出明文 key（仅服务端内部，绝不外传）。
 */
async function getDecryptedCredential(userId, providerSlug) {
  const provider = await getProviderBySlug(providerSlug);
  if (!provider) throw new AppError('notfound', `未知供应商: ${providerSlug}`);
  const r = await query(
    'SELECT encrypted_credentials, base_url FROM provider_credentials WHERE user_id = $1 AND provider_id = $2',
    [userId, provider.id]
  );
  const row = r.rows[0];
  if (!row || !row.encrypted_credentials) {
    throw new AppError('nokey', `尚未配置 ${providerSlug} 的 API Key`);
  }
  return {
    provider,
    apiKey: decryptSecret(row.encrypted_credentials),
    baseUrl: row.base_url || provider.defaultBaseUrl,
  };
}

// ---------- 连通性测试 ----------

function mapProbeStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'badreq';
  return 'upstream';
}

/**
 * 最小鉴权探测。5s 超时、不重试、不带任何会话 Cookie/内部头。
 * 返回 {ok:true, latencyMs} 或 {ok:false, code, message}。
 */
async function testConnection({ userId, providerSlug } = {}) {
  let cred;
  try {
    cred = await getDecryptedCredential(userId, providerSlug);
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'internal', message: String(e && e.message || e) };
  }
  const { provider, apiKey, baseUrl } = cred;
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'badreq', message: '缺少 base_url' };

  const started = Date.now();
  try {
    let url;
    let headers;
    if (provider.kind === 'anthropic') {
      url = `${base}/v1/models`;
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    } else if (provider.kind === 'gemini') {
      url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      headers = {};
    } else {
      // OpenAI 兼容系
      url = `${base}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
    }
    const res = await safeFetch(url, {
      method: 'GET',
      headers,
      timeoutMs: 5000,
      retry: false,
    });
    const latencyMs = Date.now() - started;
    if (res.status < 400) return { ok: true, latencyMs };
    return {
      ok: false,
      code: mapProbeStatus(res.status),
      message: `上游返回 HTTP ${res.status}`,
    };
  } catch (e) {
    if (e instanceof AppError) {
      return { ok: false, code: e.code, message: e.message };
    }
    return { ok: false, code: 'network', message: String(e && e.message || e) };
  }
}

module.exports = {
  listForUser,
  upsert,
  remove,
  getDecryptedCredential,
  testConnection,
};
