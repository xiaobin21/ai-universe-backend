'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSafeClient } = require('../src/transport/httpClient');
const { AppError } = require('../src/core/errors');

// 注入假 fetchImpl 与假 DNS，全程不触网
function makeClient({ resolver, allowInsecure } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    // 默认成功 200
    return {
      status: 200,
      headers: { get: () => null },
      body: null,
    };
  };
  const client = createSafeClient({
    allowInsecure: Boolean(allowInsecure),
    resolver: resolver || (async () => [{ address: '203.0.113.7', family: 4 }]),
    fetchImpl,
  });
  return { client, calls };
}

function res302(location) {
  return {
    status: 302,
    headers: { get: (k) => (k === 'location' ? location : null) },
    body: null,
  };
}

// ---------- SSRF 拦截（字面 IP，不发起真实连接） ----------

for (const bad of [
  'https://169.254.169.254/latest/meta-data/',
  'https://10.0.0.5/admin',
  'https://192.168.1.1/',
  'https://127.0.0.1:8080/',
  'https://[::1]/',
]) {
  test(`safeFetch 拒绝内网/元数据字面地址: ${bad}`, async () => {
    const { client, calls } = makeClient();
    await assert.rejects(() => client(bad), (e) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'badreq');
      return true;
    });
    assert.equal(calls.length, 0, '不应发起任何真实请求');
  });
}

test('safeFetch：http 协议默认拒绝', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(() => client('http://api.example.com/x'), /仅 https/);
  assert.equal(calls.length, 0);
});

// ---------- 正常放行 + 头处理 ----------

test('safeFetch：https 正常放行，注入 X-Request-ID，剥除危险头', async () => {
  const { client, calls } = makeClient();
  const r = await client('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-secret-1234567890',
      'x-api-key': 'abcdef',
      host: 'evil.example.com',
      'x-forwarded-for': '1.2.3.4',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  const h = calls[0].options.headers;
  assert.ok(h['x-request-id'], '自动注入 X-Request-ID');
  assert.equal(h.authorization, 'Bearer sk-secret-1234567890', '鉴权头保留');
  assert.equal(h['x-api-key'], 'abcdef');
  assert.equal(h.host, undefined, 'host 头必须剥除');
  assert.equal(h['x-forwarded-for'], undefined, 'x-forwarded-* 必须剥除');
});

// ---------- 重定向：每跳重走 SSRF ----------

test('safeFetch：跟随重定向到公网', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (calls.length === 1) return res302('https://api.example.com/next');
    return { status: 200, headers: { get: () => null }, body: null };
  };
  const client = createSafeClient({
    resolver: async () => [{ address: '203.0.113.7', family: 4 }],
    fetchImpl,
  });
  const r = await client('https://api.example.com/start');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'https://api.example.com/start');
  assert.equal(calls[1], 'https://api.example.com/next');
});

test('safeFetch：重定向到内网/元数据被拒绝（第二次 SSRF 校验生效）', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return res302('https://169.254.169.254/latest/meta-data/');
  };
  const client = createSafeClient({
    resolver: async () => [{ address: '203.0.113.7', family: 4 }],
    fetchImpl,
  });
  await assert.rejects(() => client('https://api.example.com/start'), (e) => {
    assert.equal(e.code, 'badreq');
    return true;
  });
  assert.equal(calls.length, 1, '第二跳不应发出');
});

test('safeFetch：外部 AbortSignal 已 abort 时立即拒绝，不发起请求', async () => {
  const ac = new AbortController();
  ac.abort();
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client('https://api.example.com/', { signal: ac.signal, retry: false }),
    (e) => {
      assert.equal(e.code, 'cancel');
      return true;
    }
  );
  assert.equal(calls.length, 0);
});
