'use strict';

/**
 * SSRF 守卫（契约 §3.3）。
 *
 * 两道闸：
 *  1) assertUrlAllowed —— 静态 URL 校验：仅 https；http 仅在 allowInsecure 且本地 profile 时；
 *     字面 IP 命中阻断段立即拒绝；重定向每一跳都重过此闸。
 *  2) createGuardedLookup —— 在 undici 真正建 TCP 连接时做 DNS 解析，逐 IP 校验，
 *     只返回安全地址，防 DNS 重绑定（DNS 解析与连接之间的时间窗）。
 *
 * 阻断段：
 *   回环 127.0.0.0/8、::1
 *   私有 10/8、172.16/12、192.168/16、fc00::/7
 *   链路本地 169.254/16、fe80::/10
 *   云元数据显式：169.254.169.254、100.100.100.200、169.254.0.23
 *   另附：0/8、255.255.255.255、::（未指定）、IPv4-mapped 内嵌 v4 同样检查
 */

const net = require('node:net');
const { AppError } = require('../errors');

// ---------- IPv4 段判定 ----------

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const o = Number(part);
    if (o > 255) return null;
    n = (n << 8) + o >>> 0;
  }
  return n >>> 0;
}

function inCidrV4(ipInt, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',   // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16',  // 含 169.254.169.254 / 169.254.0.23
  '172.16.0.0/12',
  '192.168.0.0/16',
  '255.255.255.255/32',
];

// 显式云元数据（即使未来段表调整也要硬拒）
const METADATA_V4 = new Set([
  '169.254.169.254',
  '100.100.100.200',
  '169.254.0.23',
]);

// ---------- IPv6 段判定 ----------

// 压缩 :: 展开成 8 段（每段 16 位）
function expandIPv6(addr) {
  const a = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  if (a.includes('.')) {
    // ::ffff:a.b.c.d 或 ::a.b.c.d —— 提取内嵌 v4
    const head = a.slice(0, a.lastIndexOf(':'));
    const v4 = a.slice(a.lastIndexOf(':') + 1);
    const v4Int = ipv4ToInt(v4);
    if (v4Int !== null) {
      const hi = head.replace(/^:/, '').split(':').filter(Boolean).map((x) => parseInt(x.padEnd(4, '0'), 16) || 0);
      // 只关心 v4-mapped (::ffff:a.b.c.d) 与 v4-compat，直接返回内嵌 v4 判定
      return { v4Embedded: v4Int };
    }
  }
  const sides = a.split('::');
  if (sides.length > 2) return null;
  let head = sides[0] ? sides[0].split(':') : [];
  let tail = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { groups: nums };
}

function inCidrV6(groups, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const exp = expandIPv6(base);
  if (!exp || exp.v4Embedded !== undefined) return false;
  const baseG = exp.groups;
  const fullGroups = Math.floor(bits / 16);
  const remBits = bits % 16;
  for (let i = 0; i < fullGroups; i++) {
    if (groups[i] !== baseG[i]) return false;
  }
  if (remBits === 0) return true;
  const mask = 0xffff << (16 - remBits) & 0xffff;
  return (groups[fullGroups] & mask) === (baseG[fullGroups] & mask);
}

const BLOCKED_V6 = [
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  '::/128', // 未指定地址
];

/**
 * 判断一个 IP 字面量是否应被阻断。
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true; // 不是合法 IP 也按拒绝处理（调用方应走 DNS）
  if (family === 4) {
    if (METADATA_V4.has(ip)) return true;
    const int = ipv4ToInt(ip);
    if (int === null) return true;
    return BLOCKED_V4.some((c) => inCidrV4(int, c));
  }
  // v6
  const exp = expandIPv6(ip);
  if (!exp) return true;
  if (exp.v4Embedded !== undefined) {
    // ::ffff:a.b.c.d —— 按内嵌 v4 判定
    const v4 = exp.v4Embedded;
    if (METADATA_V4.size) {
      // 反查 v4 字符串
      const v4Str = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.');
      if (METADATA_V4.has(v4Str)) return true;
    }
    return BLOCKED_V4.some((c) => inCidrV4(v4, c));
  }
  return BLOCKED_V6.some((c) => inCidrV6(exp.groups, c));
}

// ---------- URL 静态校验 ----------

/**
 * @param {string} rawUrl
 * @param {{allowInsecure?: boolean, profile?: string}} [opts]
 * @returns {{url: URL, host: string}}
 */
function assertUrlAllowed(rawUrl, opts = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AppError('badreq', '目标地址不被允许（URL 解析失败）');
  }
  const proto = u.protocol;
  if (proto === 'https:') {
    // ok
  } else if (proto === 'http:') {
    if (!opts.allowInsecure) {
      throw new AppError('badreq', '目标地址不被允许：仅 https，http 仅限本地模式');
    }
    // 本地模式仍由 guardedLookup 限制可连 IP（见 createGuardedLookup）
  } else {
    throw new AppError('badreq', `目标地址不被允许：协议 ${proto} 不支持`);
  }

  const hostRaw = u.hostname;
  // Node 的 URL.hostname 对 IPv6 保留方括号 [::1]，须剥除再判 IP
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  // 字面 IP 直接拦截（域名则交给 guardedLookup 在连接时校验）
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new AppError('badreq', '目标地址不被允许：命中内网/回环/链路本地/元数据段');
  }
  return { url: u, host };
}

// ---------- guarded lookup（DNS 解析时校验） ----------

/**
 * @param {{allowInsecure?: boolean, profile?: string, resolver?: (hostname:string)=>Promise<Array<{address:string,family:number}>>}} [opts]
 * @returns {(hostname:string, options:any, cb:(err:Error|null, address?:string, family?:number)=>void)=>void}
 */
function createGuardedLookup(opts = {}) {
  const dns = require('node:dns');
  const resolver = opts.resolver || (async (hostname) => {
    const all = await dns.promises.lookup(hostname, { all: true });
    return all.map((r) => ({ address: r.address, family: r.family }));
  });

  return function guardedLookup(hostname, options, cb) {
    // undici 调用签名：lookup(hostname, { family, hints, all }, cb)
    const done = typeof options === 'function' ? options : cb;
    resolver(hostname)
      .then((records) => {
        const safe = (records || []).filter((r) => !isBlockedIp(r.address));
        if (safe.length === 0) {
          const err = new AppError('badreq', '目标地址不被允许：DNS 解析结果全部命中内网/元数据段');
          return done(err);
        }
        const pick = safe[0];
        done(null, pick.address, pick.family || net.isIP(pick.address));
      })
      .catch((e) => {
        done(new AppError('network', `DNS 解析失败: ${hostname}`, { cause: e }));
      });
  };
}

module.exports = { assertUrlAllowed, createGuardedLookup, isBlockedIp };
