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

  // ---- 动态模型目录：启动后短延迟非阻塞跑一次发现（失败只 warn，绝不阻断启动/健康检查）----
  let intervalHandle = null;
  if (config.discoveryEnabled) {
    // eslint-disable-next-line global-require
    const { defaultCatalogDiscovery } = require('./core/discovery/catalogDiscovery');
    const boot = async () => {
      try {
        const { defaultCatalogDiscovery } = require('./core/discovery/catalogDiscovery');
        const summary = await defaultCatalogDiscovery().run({ trigger: 'startup', adminUserId: null });
        console.log(`[catalog] 启动发现完成：added=${summary.totals.added} deprecated=${summary.totals.markedDeprecated} skipped=${summary.totals.skipped}`);
      } catch (e) {
        console.warn('[catalog] 启动发现失败（不影响启动）:', e && e.message);
      }
    };
    setTimeout(boot, Math.max(0, config.discoveryStartupDelayMs)).unref();

    const hours = config.discoveryIntervalHours;
    if (hours && hours > 0) {
      intervalHandle = setInterval(() => {
        defaultCatalogDiscovery().run({ trigger: 'interval', adminUserId: null })
          .catch((e) => console.warn('[catalog] 周期发现失败:', e && e.message));
      }, hours * 3600 * 1000);
      intervalHandle.unref();
    }
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，开始优雅关停…`);
    if (intervalHandle) clearInterval(intervalHandle);
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
