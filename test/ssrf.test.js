'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedIp, assertUrlAllowed, createGuardedLookup } = require('../src/core/security/ssrf');
const { AppError } = require('../src/core/errors');

// ---------- isBlockedIp ----------

test('isBlockedIp：回环 / 私有 / 链路本地 / 元数据 全部拒绝', () => {
  const blocked = [
    '127.0.0.1', '127.5.6.7',           // 127/8
    '10.0.0.1', '10.255.255.254',       // 10/8
    '172.16.0.1', '172.31.255.254',     // 172.16/12
    '192.168.1.1', '192.168.0.254',     // 192.168/16
    '169.254.169.254',                  // 云元数据
    '100.100.100.200',                  // 阿里云元数据
    '169.254.0.23',                     // 腾讯云
    '169.254.1.5',                      // 链路本地
    '0.0.0.0', '0.1.2.3',               // 本网络段
    '::1',                              // v6 回环
    'fc00::1', 'fd12:3456::1',          // fc00::/7
    'fe80::1',                          // fe80::/10
    '::',                               // 未指定
    '::ffff:127.0.0.1',                 // v4-mapped 回环
    '::ffff:10.1.2.3',                  // v4-mapped 私网
  ];
  for (const ip of blocked) assert.ok(isBlockedIp(ip), `应阻断: ${ip}`);
});

test('isBlockedIp：公网 IP 放行', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '203.0.113.7', '93.184.216.34', '2606:4700:4700::1111'];
  for (const ip of allowed) assert.ok(!isBlockedIp(ip), `应放行: ${ip}`);
});

// ---------- assertUrlAllowed ----------

test('assertUrlAllowed：https 正常放行', () => {
  const r = assertUrlAllowed('https://api.openai.com/v1/chat/completions');
  assert.equal(r.host, 'api.openai.com');
  assert.equal(r.url.protocol, 'https:');
});

test('assertUrlAllowed：http 默认拒绝', () => {
  assert.throws(() => assertUrlAllowed('http://api.example.com'), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'badreq');
    return true;
  });
});

test('assertUrlAllowed：http 在 allowInsecure 下、且非字面内网 IP 时放行', () => {
  const r = assertUrlAllowed('http://lanbox.local:11434/api', { allowInsecure: true });
  assert.equal(r.host, 'lanbox.local');
});

test('assertUrlAllowed：字面私网/元数据 IP 直接拒', () => {
  for (const u of [
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/admin',
    'https://192.168.1.1/',
    'https://[::1]/',
    'http://127.0.0.1:11434/',
  ]) {
    assert.throws(() => assertUrlAllowed(u, { allowInsecure: true }), /目标地址不被允许/);
  }
});

test('assertUrlAllowed：非 http(s) 协议拒绝', () => {
  assert.throws(() => assertUrlAllowed('ftp://files.example.com/x'), /协议/);
  assert.throws(() => assertUrlAllowed('file:///etc/passwd'), /协议/);
});

test('assertUrlAllowed：非法 URL 拒绝', () => {
  assert.throws(() => assertUrlAllowed('not a url'), /URL 解析失败/);
});

// ---------- createGuardedLookup（注入 resolver，不依赖真实 DNS/外网） ----------

function guarded(opts = {}) {
  return new Promise((resolve, reject) => {
    const lookup = createGuardedLookup(opts);
    lookup('example.internal', {}, (err, address, family) => {
      if (err) return reject(err);
      resolve({ address, family });
    });
  });
}

test('guardedLookup：DNS 解析到私网/元数据 -> 回调错误', async () => {
  const resolver = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '10.0.0.8', family: 4 },
    { address: '192.168.1.2', family: 4 },
    { address: '169.254.169.254', family: 4 },
    { address: '::1', family: 6 },
  ];
  for (const addr of ['127.0.0.1', '10.0.0.8', '192.168.1.2', '169.254.169.254', '::1']) {
    const r = async () =>
      new Promise((res, rej) =>
        createGuardedLookup({ resolver: async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }] })(
          'h', {}, (e, a, f) => (e ? rej(e) : res({ a, f }))
        )
      );
    await assert.rejects(r, /不被允许/);
  }
});

test('guardedLookup：解析到公网 IP -> 放行并返回该 IP', async () => {
  const resolver = async () => [
    { address: '10.0.0.1', family: 4 },      // 第一个是私网，应被过滤
    { address: '203.0.113.7', family: 4 },    // 公网，应被选中
  ];
  const { address, family } = await guarded({ resolver });
  assert.equal(address, '203.0.113.7');
  assert.equal(family, 4);
});

test('guardedLookup：DNS 失败 -> network 错误', async () => {
  const resolver = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(() => guarded({ resolver }), (e) => {
    assert.equal(e.code, 'network');
    return true;
  });
});
