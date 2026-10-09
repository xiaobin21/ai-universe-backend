'use strict';

/**
 * 认证 Express 中间件（契约 §8）。
 *  - requireAuth：Bearer access JWT -> 装载 req.user；禁用账号 403；缺失/失效 401。
 *  - optionalAuth：未带 token 不报错，req.user 保持 null。
 *  - requireAdmin：在 requireAuth 基础上要求 tier='admin'。
 */

const jwt = require('jsonwebtoken');
const { config } = require('../../config');
const { AppError } = require('../errors');
const { findActiveUserById } = require('./auth.service');
const { resolveIsAdmin } = require('./admin');

function parseBearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

/**
 * 装载主体；optional=true 时缺 token 静默放行（req.user=null）。
 */
async function loadPrincipal(req, { optional = false } = {}) {
  const token = parseBearer(req);
  req.user = null;
  req.authError = null;

  if (!token) {
    if (optional) return;
    throw new AppError('auth', '未登录或缺少访问令牌');
  }
  let payload;
  try {
    if (!config.jwtSecret) throw new Error('JWT_SECRET 未配置');
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    throw new AppError('auth', '访问令牌无效或已过期');
  }
  if (!payload || payload.typ !== 'access' || !payload.sub) {
    throw new AppError('auth', '访问令牌类型不正确');
  }
  const user = await findActiveUserById(payload.sub);
  if (!user) throw new AppError('auth', '用户不存在或已被删除');
  if (user.disabled_at) throw new AppError('forbidden', '账号已被禁用');
  req.user = user;
}

/** async 包装：Express 4 不自动捕获 Promise 拒绝。 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireAuth = wrap(async (req, res, next) => {
  await loadPrincipal(req, { optional: false });
  next();
});

const optionalAuth = wrap(async (req, res, next) => {
  await loadPrincipal(req, { optional: true });
  next();
});

const requireAdmin = wrap(async (req, res, next) => {
  if (!req.user) return next(new AppError('auth', '未登录'));
  if (!(await resolveIsAdmin(req.user))) {
    return next(new AppError('forbidden', '需要管理员权限'));
  }
  next();
});

module.exports = { requireAuth, requireAdmin, optionalAuth, parseBearer, loadPrincipal };
