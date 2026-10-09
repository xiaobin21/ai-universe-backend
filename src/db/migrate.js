'use strict';

/**
 * 轻量迁移 runner（契约 §5）。
 * - schema_migrations(version PK, applied_at)
 * - 按文件名顺序执行 src/db/migrations/*.sql，每个文件在一个事务内
 * - 已记录版本跳过；可反复执行（npm run migrate）
 */

const fs = require('node:fs');
const path = require('node:path');
const { query, withTransaction, endPool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTable() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function runMigrations() {
  await ensureTable();
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 字典序即版本序（001_xxx, 002_xxx ...）

  let applied = 0;
  for (const file of files) {
    const done = await query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (done.rowCount > 0) {
      console.log(`[migrate] 跳过 ${file}（已应用）`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
    });
    console.log(`[migrate] 已应用 ${file}`);
    applied += 1;
  }
  console.log(`[migrate] 完成：共 ${files.length} 个迁移，本次新应用 ${applied} 个`);
  return { total: files.length, applied };
}

if (require.main === module) {
  runMigrations()
    .then(() => endPool())
    .catch(async (e) => {
      console.error('[migrate] 失败:', e.message);
      await endPool().catch(() => {});
      process.exit(1);
    });
}

module.exports = { runMigrations };
