'use strict';

/**
 * 启动入口（契约 §15）。
 *  1) config fail-fast（assertProductionConfig）
 *  2) RUN_MIGRATE / RUN_SEED 控制迁移与种子
 *  3) listen PORT；/healthz、/readyz
 *  4) SIGTERM/SIGINT 优雅关停：停接新请求、等待在跑 job 落库、endPool 后退出
 */

const { config, assertProductionConfig } = require('./config');
const { endPool } = require('./db/pool');
const { runMigrations } = require('./db/migrate');
const { seed } = require('./db/seed');
const { createApp } = require('./app');

async function main() {
  assertProductionConfig();

  if (config.runMigrate) {
    await runMigrations();
  }
  if (config.runSeed) {
    await seed();
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (env=${config.env})`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，开始优雅关停…`);
    server.close(() => console.log('[server] 已停止接收新请求'));

    // 等待在跑的流式任务自然落库（这里依赖 SSE 连接随请求断开而收尾）
    setTimeout(async () => {
      try { await endPool(); } catch (_) { /* 忽略 */ }
      console.log('[server] 已关闭 DB 连接池，退出');
      process.exit(0);
    }, 3000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error('[server] 启动失败:', e && e.message);
    await endPool().catch(() => {});
    process.exit(1);
  });
}

module.exports = { main };
