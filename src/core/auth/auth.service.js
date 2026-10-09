'use strict';

/**
 * 认证服务（契约 §8.1 / §10 账号安全）。
 *
 *  - 密码：bcryptjs cost=10 哈希，绝不存明文。
 *  - 登录失败：连续 5 次锁 15 分钟（users.failed_login_count / locked_until），成功清零。
 *  - access：JWT（config.jwtSecret，默认 15m），放响应体。
 *  - refresh：随机 32B token，DB 只存 sha256 哈希（user_sessions.refresh_token_hash），
 *    明文通过 httpOnly cookie au_refresh 下发；会话可撤销。
 *  - 所有关键动作写 audit_logs。
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../../db/pool');
const { config } = require('../../config');
const { AppError } = require('../errors');

const BCRYPT_COST = 10;
const MAX_FAILED = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/** 带前缀主键（契约 §5：usr_/ses_/aud_） */
function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ---------- 入参校验 ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCredentialInput({ email, password }) {
  const em = String(email == null ? '' : email).trim().toLowerCase();
  if (!EMAIL_RE.test(em)) throw new AppError('badreq', '邮箱格式不正确');
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new AppError('badreq', '密码至少 8 位');
  }
  return { email: em };
}

// ---------- 审计 ----------

async function audit({ userId, action, ip, meta }) {
  try {
    await query(
      'INSERT INTO audit_logs(id, user_id, action, ip, meta_json) VALUES($1,$2,$3,$4,$5)',
      [genId('aud'), userId || null, action, ip || null, JSON.stringify(meta || {})]
    );
  } catch (e) {
    // 审计失败不应阻断主流程，但要在 stderr 留痕（不含敏感信息）
    console.error('[audit] 写入失败:', action, e && e.message);
  }
}

// ---------- JWT / 会话 ----------

function issueAccessToken(user) {
  if (!config.jwtSecret) {
    throw new AppError('internal', 'JWT_SECRET 未配置');
  }
  return jwt.sign(
    { sub: user.id, email: user.email, typ: 'access' },
    config.jwtSecret,
    { expiresIn: config.jwtAccessTtl || '15m' }
  );
}

async function createSession(userId, { ip, userAgent } = {}) {
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const refreshHash = sha256Hex(refreshToken);
  const sessionId = genId('ses');
  const days = Number(config.jwtRefreshTtlDays) || 7;
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
  await query(
    `INSERT INTO user_sessions(id, user_id, refresh_token_hash, expires_at, ip, user_agent)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [sessionId, userId, refreshHash, expiresAt, ip || null, (userAgent || '').slice(0, 500)]
  );
  return { sessionId, refreshToken, refreshExpiresAt: expiresAt };
}

function publicUser(user) {
  return { id: user.id, email: user.email, tier: user.tier || 'free' };
}

// ---------- 注册 / 登录 ----------

/**
 * 注册新用户。
 * @param {{email:string,password:string,ip?:string,userAgent?:string}} input
 */
async function register({ email, password, ip, userAgent } = {}) {
  const { email: em } = validateCredentialInput({ email, password });
  const exists = await query('SELECT id FROM users WHERE lower(email) = $1', [em]);
  if (exists.rows.length) throw new AppError('conflict', '该邮箱已注册');

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const userId = genId('usr');
  await query(
    'INSERT INTO users(id, email, password_hash) VALUES($1,$2,$3)',
    [userId, em, passwordHash]
  );
  // 默认设置（幂等）
  await query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);

  const session = await createSession(userId, { ip, userAgent });
  const accessToken = issueAccessToken({ id: userId, email: em });
  await audit({ userId, action: 'register', ip, meta: { email: em } });
  return { user: { id: userId, email: em, tier: 'free' }, accessToken, ...session };
}

/**
 * 登录。失败累计 5 次锁 15 分钟；成功清零。
 */
async function login({ email, password, ip, userAgent } = {}) {
  const em = String(email == null ? '' : email).trim().toLowerCase();
  const generic = () => new AppError('auth', '邮箱或密码错误');

  const r = await query('SELECT * FROM users WHERE lower(email) = $1', [em]);
  const user = r.rows[0];
  if (!user) {
    await audit({ action: 'login_unknown_user', ip, meta: { email: em } });
    throw generic();
  }
  if (user.disabled_at) {
    await audit({ userId: user.id, action: 'login_disabled', ip });
    throw new AppError('forbidden', '账号已被禁用');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await audit({ userId: user.id, action: 'login_locked', ip });
    throw new AppError('rate', '失败次数过多，账户已临时锁定，请 15 分钟后再试');
  }

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    // 上一轮锁已过期：从 1 开始重新计数
    let count = Number(user.failed_login_count || 0) + 1;
    if (user.locked_until && new Date(user.locked_until) <= new Date()) count = 1;

    if (count >= MAX_FAILED) {
      await query(
        `UPDATE users
         SET failed_login_count = $1, locked_until = to_timestamp($2/1000.0)
         WHERE id = $3`,
        [count, Date.now() + LOCK_DURATION_MS, user.id]
      );
    } else {
      await query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [count, user.id]);
    }
    await audit({ userId: user.id, action: 'login_failed', ip, meta: { count } });
    throw generic();
  }

  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const session = await createSession(user.id, { ip, userAgent });
  const accessToken = issueAccessToken(user);
  await audit({ userId: user.id, action: 'login_success', ip });
  return { user: publicUser(user), accessToken, ...session };
}

// ---------- refresh / 会话管理 ----------

/**
 * 凭 refresh token 明文换 access。校验会话存在、未撤销、未过期、账号未禁用。
 */
async function refreshByToken(refreshToken) {
  if (!refreshToken) throw new AppError('auth', '缺少 refresh token');
  const hash = sha256Hex(refreshToken);
  const r = await query(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
            u.id AS uid, u.email, u.tier, u.disabled_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1`,
    [hash]
  );
  const row = r.rows[0];
  if (!row) throw new AppError('auth', '会话无效或已注销');
  if (row.revoked_at) throw new AppError('auth', '会话已撤销，请重新登录');
  if (new Date(row.expires_at) <= new Date()) throw new AppError('auth', '会话已过期，请重新登录');
  if (row.disabled_at) throw new AppError('forbidden', '账号已被禁用');

  const accessToken = issueAccessToken({ id: row.uid, email: row.email });
  return { accessToken, sessionId: row.session_id, user: { id: row.uid, email: row.email, tier: row.tier } };
}

/** 按明文 refresh token 定位会话（用于 logout / sessions.current 标记）。 */
async function findSessionByRefreshToken(refreshToken) {
  if (!refreshToken) return null;
  const hash = sha256Hex(refreshToken);
  const r = await query('SELECT * FROM user_sessions WHERE refresh_token_hash = $1', [hash]);
  return r.rows[0] || null;
}

/** 撤销某用户指定会话（仅当属于该用户）。 */
async function revokeSession(userId, sessionId) {
  await query(
    'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [sessionId, userId]
  );
}

/** 撤销当前 refresh token 对应的会话。 */
async function revokeSessionByRefreshToken(refreshToken, { ip } = {}) {
  const s = await findSessionByRefreshToken(refreshToken);
  if (s) {
    await query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [s.id]);
    await audit({ userId: s.user_id, action: 'logout', ip });
  }
  return Boolean(s);
}

/** 列出当前用户未撤销会话；currentId 用于标记「当前会话」。 */
async function listSessions(userId, currentSessionId) {
  const r = await query(
    `SELECT id, ip, user_agent AS userAgent, created_at AS createdAt, expires_at AS expiresAt
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map((row) => ({
    id: row.id,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    current: row.id === currentSessionId,
  }));
}

/**
 * 全量撤销某用户全部会话（改密/踢下线时调用）。
 * @returns {number} 撤销条数
 */
async function revokeAllUserSessions(userId, { exceptSessionId } = {}) {
  const params = [userId];
  let sql = 'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL';
  if (exceptSessionId) {
    sql += ' AND id <> $2';
    params.push(exceptSessionId);
  }
  const r = await query(sql, params);
  return r.rowCount || 0;
}

/** 按 id 加载在线主体（中间件用）。 */
async function findActiveUserById(userId) {
  const r = await query('SELECT id, email, tier, disabled_at, created_at FROM users WHERE id = $1', [userId]);
  return r.rows[0] || null;
}

module.exports = {
  register,
  login,
  issueAccessToken,
  refreshByToken,
  findSessionByRefreshToken,
  revokeSession,
  revokeSessionByRefreshToken,
  revokeAllUserSessions,
  listSessions,
  findActiveUserById,
  audit,
};
