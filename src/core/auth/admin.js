'use strict';

/**
 * 管理员判定（不引入角色表）。
 *
 * 口径（满足任一即为管理员）：
 *   1) 平台账号：users.tier = 'admin'；
 *   2) 邮箱命中环境变量 ADMIN_EMAILS（逗号分隔，大小写不敏感）；
 *   3) 当 ADMIN_EMAILS 未配置时，“首个注册用户”（created_at 最早，并列时 id 最小）兜底为管理员。
 *
 * 说明：第 3 条是为了让自部署者在未配置任何变量时也能管理后台；一旦显式配置 ADMIN_EMAILS，
 * 即完全以该名单 + 平台账号为准，不再使用首用户兜底。
 */

const { config } = require('../../config');
const { query } = require('../../db/pool');

function isPlatformAdmin(user) {
  return !!user && user.tier === 'admin';
}

function isEmailListed(user) {
  if (!user || !user.email) return false;
  return config.adminEmails.includes(String(user.email).trim().toLowerCase());
}

/**
 * 是否为“首个注册用户”：不存在 created_at 严格更早（或同刻 id 更小）的未禁用用户。
 */
async function isFirstRegisteredUser(user) {
  if (!user || !user.id) return false;
  const createdAt = user.created_at || new Date().toISOString();
  const r = await query(
    `SELECT 1 FROM users
      WHERE disabled_at IS NULL
        AND (created_at < $2 OR (created_at = $2 AND id < $1))
      LIMIT 1`,
    [user.id, createdAt]
  );
  return r.rows.length === 0;
}

/**
 * 异步判定管理员（含首用户查询）。路由/服务需要权威结论时使用。
 * @param {object} user 已装载的 req.user（含 id/email/tier/created_at）
 * @returns {Promise<boolean>}
 */
async function resolveIsAdmin(user) {
  if (!user) return false;
  if (isPlatformAdmin(user)) return true;
  if (isEmailListed(user)) return true;
  if (config.adminEmails.length === 0 && await isFirstRegisteredUser(user)) return true;
  return false;
}

module.exports = {
  resolveIsAdmin,
  isPlatformAdmin,
  isEmailListed,
  isFirstRegisteredUser,
};
