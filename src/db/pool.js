'use strict';

/**
 * PostgreSQL 连接池（契约 §5）。
 * - 连接串取 config.DATABASE_URL
 * - SSL：DB_SSL=auto 时，生产/Render 开启 ssl:{rejectUnauthorized:false}，本地关闭
 * - 导出 query / withTransaction(fn) / getPool / endPool
 */

const { Pool } = require('pg');
const { config } = require('../config');

let pool = null;

function resolveSsl() {
  const mode = (config.dbSsl || 'auto').toLowerCase();
  if (mode === 'true' || mode === '1' || mode === 'on') return { rejectUnauthorized: false };
  if (mode === 'false' || mode === '0' || mode === 'off') return false;
  // auto
  return config.isProduction ? { rejectUnauthorized: false } : false;
}

function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL 未配置（本地用 docker-compose / scripts/local-pg.js，Render 用 Internal Database URL）');
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: resolveSsl(),
    max: Number(process.env.PG_POOL_MAX || 10),
  });
  pool.on('error', (e) => {
    console.error('[pg] 空闲连接错误:', e && e.message);
  });
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * 在一个事务里执行 fn(client)；fn 抛错自动回滚。
 * @param {(client: import('pg').Client) => Promise<any>} fn
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 连接可能已断 */ }
    throw e;
  } finally {
    client.release();
  }
}

async function endPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, withTransaction, getPool, endPool };
