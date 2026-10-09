'use strict';

/**
 * 本地 PostgreSQL 守护进程（仅用于本地开发 / CI 验证，Render 上使用托管 Postgres）。
 * 基于 embedded-postgres：免 root、免 Docker，在工作区初始化并启动一个真实 Postgres。
 *
 *   node scripts/local-pg.js                 # 前台运行，打印 DATABASE_URL，Ctrl+C 停止
 *
 * 可选环境：PG_PORT(默认55432) PG_USER(aiuniverse) PG_PASSWORD(aiuniverse)
 *           PG_DATABASE(aiuniverse) PG_DIR(.epg-data)
 */

const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = Number(process.env.PG_PORT || 55432);
const USER = process.env.PG_USER || 'aiuniverse';
const PASSWORD = process.env.PG_PASSWORD || 'aiuniverse';
const DATABASE = process.env.PG_DATABASE || 'aiuniverse';
const DIR = process.env.PG_DIR || `${process.cwd()}/.epg-data`;

const pg = new EmbeddedPostgres({
  databaseDir: DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  initdbFlags: [],
  postgresFlags: [],
});

async function ensureDatabase() {
  const { Client } = require('pg');
  // 先连默认维护库 postgres
  const admin = new Client({ host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DATABASE]).then(async (r) => {
    if (r.rowCount === 0) {
      // 标识符不可参数化，名称来自本地受控环境变量
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      console.log(`[local-pg] 已创建数据库 ${DATABASE}`);
    }
  });
  await admin.end();
}

async function main() {
  await pg.initialise();
  await pg.start();
  await ensureDatabase();
  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
  console.log(`[local-pg] PostgreSQL 已启动: ${url}`);
  console.log('[local-pg] 另开终端执行： DATABASE_URL="' + url + '" npm run migrate && npm run seed');
}

async function shutdown() {
  try { await pg.stop(); } catch (e) { /* 忽略 */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('[local-pg] 启动失败:', e.message);
  process.exit(1);
});
