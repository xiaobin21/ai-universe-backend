'use strict';

/**
 * 集中配置（契约 §0.8）。
 * - 启动时 fail-fast 校验关键项（仅生产环境强制，本地/测试可缺省以便单测 hermetic）。
 * - 所有读取都在“调用时”从 process.env 取，便于测试在 require 之后再设 env。
 */

const path = require('path');

try {
  // 可选加载 .env；缺失不报错（生产走平台 Secret 注入）
  require('dotenv').config({ path: process.env.ENV_FILE || path.join(process.cwd(), '.env') });
} catch (_) { /* dotenv 缺失也无妨 */ }

const bool = (v, dflt = false) =>
  v === undefined ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v));

const int = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const config = {
  get env() { return str(process.env.NODE_ENV, 'development'); },
  get isProduction() { return this.env === 'production'; },
  get port() { return int(process.env.PORT, 8080); },

  get databaseUrl() { return str(process.env.DATABASE_URL); },
  get dbSsl() { return str(process.env.DB_SSL, 'auto'); },

  get masterEncryptionKey() { return str(process.env.MASTER_ENCRYPTION_KEY); },
  get encryptionKeyId() { return str(process.env.ENCRYPTION_KEY_ID, 'k1'); },
  get encryptionKeysJson() { return str(process.env.ENCRYPTION_KEYS); },

  get jwtSecret() { return str(process.env.JWT_SECRET); },
  get jwtAccessTtl() { return str(process.env.JWT_ACCESS_TTL, '15m'); },
  get jwtRefreshTtlDays() { return int(process.env.JWT_REFRESH_TTL_DAYS, 7); },

  get corsOrigins() { return str(process.env.CORS_ORIGINS); },

  get runMigrate() { return bool(process.env.RUN_MIGRATE, true); },
  get runSeed() { return bool(process.env.RUN_SEED, true); },

  get defaultDailyBudgetMicro() { return int(process.env.DEFAULT_DAILY_BUDGET_MICRO, 10_000_000); },
  get defaultMaxOutputTokens() { return int(process.env.DEFAULT_MAX_OUTPUT_TOKENS, 4096); },
  get maxConcurrentJobs() { return int(process.env.MAX_CONCURRENT_JOBS, 3); },
  get rateLimitApiPerMin() { return int(process.env.RATE_LIMIT_API_PER_MIN, 60); },

  get allowInsecureLocalMode() { return bool(process.env.ALLOW_INSECURE_LOCAL_MODE, false); },
  get localModelMode() { return bool(process.env.LOCAL_MODEL_MODE, false); },
  get localModelAllowlist() { return str(process.env.LOCAL_MODEL_ALLOWLIST, ''); },

  get adminBootstrapEmail() { return str(process.env.ADMIN_BOOTSTRAP_EMAIL); },
  get globalReadonly() { return bool(process.env.GLOBAL_READONLY, false); },

  // ---- 动态模型目录：管理员判定 / 发现 / 探测 / Cron ----
  /** ADMIN_EMAILS 逗号分隔；命中即管理员（统一小写比较）。 */
  get adminEmails() {
    return str(process.env.ADMIN_EMAILS)
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  },
  get cronSecret() { return str(process.env.CRON_SECRET); },

  get discoveryEnabled() { return bool(process.env.CATALOG_DISCOVERY_ENABLED, true); },
  get discoveryStartupDelayMs() { return int(process.env.CATALOG_DISCOVERY_STARTUP_DELAY_MS, 8000); },
  /** 周期发现间隔（小时），默认 24；设 0 关闭周期任务（免费实例仅在存活期间运行）。 */
  get discoveryIntervalHours() {
    return process.env.CATALOG_DISCOVERY_INTERVAL_HOURS === undefined
      ? 24 : int(process.env.CATALOG_DISCOVERY_INTERVAL_HOURS, 24);
  },
  get discoveryTimeoutMs() { return int(process.env.CATALOG_DISCOVERY_TIMEOUT_MS, 15000); },
  get discoveryDeprecateAfterMisses() { return int(process.env.CATALOG_DEPRECATE_AFTER_MISSES, 2); },
  get modelProbeEnabled() { return bool(process.env.MODEL_PROBE_ENABLED, true); },
  get modelProbeConcurrency() { return int(process.env.MODEL_PROBE_CONCURRENCY, 3); },
};

/**
 * 平台共享 Key（环境变量）。每个供应商对应若干候选变量名，按序取第一个非空。
 * 注意：这是平台级 Key；用户私有凭证在 provider_credentials，由发现服务按规则选择。
 */
const PLATFORM_KEY_ENV = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
  doubao: ['DOUBAO_API_KEY', 'ARK_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
};

function getPlatformKey(provider) {
  const names = PLATFORM_KEY_ENV[provider] || [];
  for (const n of names) {
    if (process.env[n]) return String(process.env[n]);
  }
  return null;
}

/** 平台自定义 Base URL（可选，多数供应商用适配器默认）。 */
const PLATFORM_BASE_ENV = {
  openai: 'OPENAI_BASE_URL', anthropic: 'ANTHROPIC_BASE_URL', gemini: 'GEMINI_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL', qwen: 'QWEN_BASE_URL', zhipu: 'ZHIPU_BASE_URL',
  doubao: 'DOUBAO_BASE_URL', kimi: 'KIMI_BASE_URL',
};
function getPlatformBaseUrl(provider) {
  const n = PLATFORM_BASE_ENV[provider];
  return n && process.env[n] ? String(process.env[n]) : null;
}

/**
 * 生产启动前强制校验；缺失项抛错并列出名字。本地/测试可放宽。
 */
function assertProductionConfig() {
  if (!config.isProduction) return;
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.masterEncryptionKey) missing.push('MASTER_ENCRYPTION_KEY');
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error('生产环境缺少必要环境变量: ' + missing.join(', '));
  }
}

module.exports = { config, assertProductionConfig, getPlatformKey, getPlatformBaseUrl };
