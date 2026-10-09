'use strict';

/**
 * 测试专用：启动一个免 root / 免 Docker 的真实 PostgreSQL（embedded-postgres），
 * 并在其上执行迁移（可选种子）。每个实例使用独立端口与数据目录，可安全并行。
 *
 *   const t = await startTestPg({ seed: true });
 *   // process.env.DATABASE_URL 已指向该实例；之后再 require 业务模块
 *   await t.stop();
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const EmbeddedPostgres = require('embedded-postgres').default;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function startTestPg({ seed = false, port } = {}) {
  const listenPort = port || (await freePort());
  const suffix = `${listenPort}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(process.cwd(), '.epg-data', `test-${suffix}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'aiuniverse',
    password: 'aiuniverse',
    port: listenPort,
    persistent: false,
    initdbFlags: [],
    postgresFlags: [],
  });

  await pg.initialise();
  await pg.start();

  // 测试统一使用默认维护库 postgres（无需额外建库）
  const url = `postgres://aiuniverse:aiuniverse@127.0.0.1:${listenPort}/postgres`;
  process.env.DATABASE_URL = url;

  const runNodeScript = (script) =>
    spawnSync('node', [script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });

  const mig = runNodeScript('src/db/migrate.js');
  if (mig.status !== 0) {
    throw new Error(`测试库迁移失败: ${mig.stderr || mig.stdout}`);
  }
  if (seed) {
    const sd = runNodeScript('src/db/seed.js');
    if (sd.status !== 0) {
      throw new Error(`测试库种子失败: ${sd.stderr || sd.stdout}`);
    }
  }

  async function stop() {
    try { await pg.stop(); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  return { url, port: listenPort, stop };
}

module.exports = { startTestPg };
