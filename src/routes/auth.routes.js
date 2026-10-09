'use strict';

/**
 * 认证路由（契约 §8.1，前缀 /api/auth）。
 *
 *  - access token 放响应体（{accessToken}）；refresh token 走 httpOnly cookie au_refresh。
 *  - cookie 域 Path=/api/auth，SameSite=Lax；生产追加 Secure。
 *  - 登录/注册加 IP+邮箱 维度限流（进程内，默认宽松以便测试；生产可调 RATE_LIMIT_AUTH_MAX）。
 */

const express = require('express');
const auth = require('../core/auth/auth.service');
const { requireAuth } = require('../core/auth/middleware');
const { rateLimit } = require('../core/security/rateLimit');
const { config } = require('../config');

const REFRESH_COOKIE = 'au_refresh';
const REFRESH_PATH = '/api/auth';

function getClientIp(req) {
  return (
    (req.headers && (req.headers['x-real-ip'] || req.socket?.remoteAddress)) ||
    req.ip ||
    null
  );
}

function getUserAgent(req) {
  return (req.headers && req.headers['user-agent']) || null;
}

function getRefreshCookie(req) {
  const h = String((req.headers && req.headers.cookie) || '');
  const m = h.match(/(?:^|;\s*)au_refresh=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function setRefreshCookie(res, token) {
  const days = Number(config.jwtRefreshTtlDays) || 7;
  const maxAge = days * 24 * 3600;
  const secure = config.isProduction ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${token}; HttpOnly; Path=${REFRESH_PATH}; Max-Age=${maxAge}; SameSite=Lax${secure}`
  );
}

function clearRefreshCookie(res) {
  res.append(
    'Set-Cookie',
    `${REFRESH_COOKIE}=; HttpOnly; Path=${REFRESH_PATH}; Max-Age=0; SameSite=Lax`
  );
}

/** Express 4 async 包装：Promise 拒绝必须显式 next(err)。 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 登录/注册限流：IP+email，默认 20/15min（生产可通过 AUTH_RATE_LIMIT_MAX 收紧）。 */
const authLimiter = rateLimit({
  keyBy: (req) => `${getClientIp(req)}|${String((req.body && req.body.email) || '').toLowerCase()}`,
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  message: '尝试过于频繁，请 15 分钟后再试',
});

function buildRouter() {
  const router = express.Router();

  // POST /api/auth/register
  router.post('/register', authLimiter, wrap(async (req, res) => {
    const out = await auth.register({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    setRefreshCookie(res, out.refreshToken);
    res.status(201).json({ user: out.user, accessToken: out.accessToken });
  }));

  // POST /api/auth/login
  router.post('/login', authLimiter, wrap(async (req, res) => {
    const out = await auth.login({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    setRefreshCookie(res, out.refreshToken);
    res.json({ user: out.user, accessToken: out.accessToken });
  }));

  // POST /api/auth/refresh —— 凭 cookie 换新 access
  router.post('/refresh', wrap(async (req, res) => {
    const token = getRefreshCookie(req);
    const out = await auth.refreshByToken(token);
    res.json({ accessToken: out.accessToken, user: out.user });
  }));

  // POST /api/auth/logout —— 撤销当前会话
  router.post('/logout', requireAuth, wrap(async (req, res) => {
    const token = getRefreshCookie(req);
    await auth.revokeSessionByRefreshToken(token, { ip: getClientIp(req) });
    clearRefreshCookie(res);
    res.status(204).end();
  }));

  // GET /api/auth/me
  router.get('/me', requireAuth, wrap(async (req, res) => {
    res.json({ user: { id: req.user.id, email: req.user.email, tier: req.user.tier } });
  }));

  // GET /api/auth/sessions
  router.get('/sessions', requireAuth, wrap(async (req, res) => {
    const cur = await auth.findSessionByRefreshToken(getRefreshCookie(req));
    const sessions = await auth.listSessions(req.user.id, cur ? cur.id : null);
    res.json({ sessions });
  }));

  // POST /api/auth/sessions/:id/revoke
  router.post('/sessions/:id/revoke', requireAuth, wrap(async (req, res) => {
    await auth.revokeSession(req.user.id, req.params.id);
    res.status(204).end();
  }));

  return router;
}

module.exports = buildRouter;
module.exports.getRefreshCookie = getRefreshCookie;
