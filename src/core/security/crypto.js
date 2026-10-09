'use strict';

/**
 * 凭证加解密（契约 §4.1，AES-256-GCM）。
 *
 * 密文格式（固定，便于轮换/多 key 解码）：
 *   v1:<keyId>:<base64(nonce 12B)>:<base64(ciphertext)>:<base64(tag 16B)>
 *
 * 主密钥只来自环境变量：
 *   MASTER_ENCRYPTION_KEY  当前 key（base64，32 字节）
 *   ENCRYPTION_KEY_ID      当前 key 逻辑 id
 *   ENCRYPTION_KEYS        旧 key JSON（仅用于解密，不参与新写入）
 *
 * 安全：每次加密随机 nonce；密钥绝不入库/入日志/入仓库。
 */

const crypto = require('node:crypto');
const { AppError } = require('../errors');

const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** 构建密钥环（调用时读取 env，便于测试注入） */
function buildKeyRing() {
  const ring = {};
  const curB64 = process.env.MASTER_ENCRYPTION_KEY;
  const curId = process.env.ENCRYPTION_KEY_ID || 'k1';
  if (curB64) ring[curId] = Buffer.from(curB64, 'base64');

  if (process.env.ENCRYPTION_KEYS) {
    let old;
    try {
      old = JSON.parse(process.env.ENCRYPTION_KEYS);
    } catch {
      throw new AppError('internal', 'ENCRYPTION_KEYS 不是合法 JSON');
    }
    for (const [id, b64] of Object.entries(old)) {
      ring[id] = Buffer.from(b64, 'base64');
    }
  }
  return ring;
}

function assertKeyLength(key, id) {
  if (!key || key.length !== KEY_BYTES) {
    throw new AppError('internal', `加密密钥 ${id} 必须是 ${KEY_BYTES} 字节（base64 解码后）`);
  }
}

/**
 * 加密明文（通常是供应商 API Key）。
 * @param {string} plaintext
 * @param {{keyId?: string}} [opts] 默认用当前 key
 * @returns {string} 密文串
 */
function encryptSecret(plaintext, opts = {}) {
  if (plaintext === undefined || plaintext === null) {
    throw new AppError('badreq', '待加密内容为空');
  }
  const ring = buildKeyRing();
  const id = opts.keyId || process.env.ENCRYPTION_KEY_ID || 'k1';
  const key = ring[id];
  assertKeyLength(key, id);

  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16B
  return ['v1', id, nonce.toString('base64'), enc.toString('base64'), tag.toString('base64')].join(':');
}

/**
 * 解密；按密文里的 keyId 选环内密钥。GCM tag 校验失败会抛 internal。
 * @param {string} payload
 * @returns {string}
 */
function decryptSecret(payload) {
  const parts = String(payload == null ? '' : payload).split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') {
    throw new AppError('internal', '密文格式非法');
  }
  const [, keyId, nonceB64, dataB64, tagB64] = parts;
  const key = buildKeyRing()[keyId];
  if (!key) {
    throw new AppError('internal', `解密密钥不存在（${keyId}），可能已被轮换删除`);
  }
  let nonce, tag;
  try {
    nonce = Buffer.from(nonceB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
  } catch {
    throw new AppError('internal', '密文 base64 段非法');
  }
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new AppError('internal', '密文长度非法');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch (e) {
    // 篡改/错误 key：GCM 校验失败
    throw new AppError('internal', '密文校验失败（密钥不匹配或被篡改）', { cause: e });
  }
}

/**
 * 脱敏：前4 + *** + 后4；过短全打码。绝不回显完整值（契约 §0.3）。
 * @param {string} secret
 * @returns {string}
 */
function maskSecret(secret) {
  const s = String(secret == null ? '' : secret);
  if (s.length === 0) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, maskSecret };
