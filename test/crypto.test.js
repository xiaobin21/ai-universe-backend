'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// 在 require 业务模块前注入密钥环（本文件独立进程，env 不会污染其他测试）
process.env.MASTER_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.ENCRYPTION_KEY_ID = 'k1';
const OLD_KEY = crypto.randomBytes(32).toString('base64');
process.env.ENCRYPTION_KEYS = JSON.stringify({ k0: OLD_KEY });

const { encryptSecret, decryptSecret, maskSecret } = require('../src/core/security/crypto');
const { AppError } = require('../src/core/errors');

test('往返：加密后解密还原原文', () => {
  const plain = 'sk-test-AbCd1234EfGh5678';
  const enc = encryptSecret(plain);
  assert.equal(decryptSecret(enc), plain);
});

test('密文格式：v1:keyId:nonce:data:tag 五段', () => {
  const enc = encryptSecret('hello');
  const parts = enc.split(':');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], 'v1');
  assert.equal(parts[1], 'k1');
  assert.ok(Buffer.from(parts[2], 'base64').length === 12, 'nonce 12B');
  assert.ok(Buffer.from(parts[4], 'base64').length === 16, 'tag 16B');
});

test('每次加密 nonce 随机：同明文两次密文不同', () => {
  const a = encryptSecret('same-plaintext');
  const b = encryptSecret('same-plaintext');
  assert.notEqual(a, b);
});

test('旧 key（k0）密文可解密，新写入用 k1', () => {
  // 用旧 key 手工构造一段密文，验证轮换解密路径
  const oldKeyBuf = Buffer.from(OLD_KEY, 'base64');
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', oldKeyBuf, nonce);
  const data = Buffer.concat([c.update('legacy-value', 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const legacy = `v1:k0:${nonce.toString('base64')}:${data.toString('base64')}:${tag.toString('base64')}`;
  assert.equal(decryptSecret(legacy), 'legacy-value');

  // 新写入一律走当前 k1
  assert.ok(encryptSecret('x').startsWith('v1:k1:'));
});

test('篡改 tag -> GCM 校验失败抛 internal', () => {
  const enc = encryptSecret('tamper-me');
  const parts = enc.split(':');
  parts[4] = Buffer.from('0'.repeat(16), 'hex').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'internal');
    return true;
  });
});

test('格式非法 / 未知 keyId -> AppError', () => {
  assert.throws(() => decryptSecret('not-a-valid-payload'), /密文格式非法/);
  assert.throws(() => decryptSecret('v1:nope:nope:nope:nope'), /解密密钥不存在/);
});

test('maskSecret：前4后4，过短全打码', () => {
  assert.equal(maskSecret('sk-abcdef123456XYZ'), 'sk-a***6XYZ');
  assert.equal(maskSecret('short'), '*****');
  assert.equal(maskSecret(''), '');
});

test('主密钥长度不符（非 32B）抛错', () => {
  const orig = process.env.MASTER_ENCRYPTION_KEY;
  process.env.MASTER_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
  try {
    assert.throws(() => encryptSecret('x'), /32 字节/);
  } finally {
    process.env.MASTER_ENCRYPTION_KEY = orig;
  }
});
