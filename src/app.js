'use strict';

/**
 * Express 装配（契约 §15）。
 *  helmet / cors（开发白名单、生产同源）/ cookie-parser / express.json(2mb) / 脱敏请求日志
 *  /api/* 各路由；静态托管 src-public（'/' 返 index.html）；404 与统一错误处理（不泄堆栈）。
 */

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { config } = require('./config');
const { AppError } = require('./core/errors');
const { redactObject } = require('./core/security/redact');
const { createChatService } = require('./core/chat/chat.service');

const buildAuthRouter = require('./routes/auth.routes');
const buildCredentialsRouter = require('./routes/credentials.routes');
const buildConversationsRouter = require('./routes/conversations.routes');
const buildChatRouter = require('./routes/chat.routes');
const buildUsageRouter = require('./routes/usage.routes');
const buildSettingsRouter = require('./routes/settings.routes');
const buildCatalogRouter = require('./routes/catalog.routes');
const buildAdminRouter = require('./routes/admin.routes');

function createApp() {
  const app = express();
  app.set('trust proxy', true);

  // ---- 安全头（前端含内联脚本/样式，放开 unsafe-inline；img 允许 data:）----
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  }));

  // ---- CORS：生产同源（不设 ACAO）；开发放开；CORS_ORIGINS 可显式配置 ----
  let corsOrigin = false;
  if (config.corsOrigins) corsOrigin = config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  else if (!config.isProduction) corsOrigin = true;
  app.use(cors({ origin: corsOrigin, credentials: true }));

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  // ---- 脱敏请求日志（不记录 query/body 敏感字段）----
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      try {
        const meta = {
          method: req.method,
          url: req.originalUrl && req.originalUrl.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        };
        if (process.env.VERBOSE_LOG) console.log('[req]', JSON.stringify(redactObject(meta)));
      } catch (_) { /* 日志不得影响请求 */ }
    });
    next();
  });

  // ---- 聊天引擎单例（内存实时流注册表在实例内）----
  app.locals.chatService = createChatService({});

  // ---- API 路由 ----
  app.use('/api/auth', buildAuthRouter());
  app.use('/api/credentials', buildCredentialsRouter());
  app.use('/api/conversations', buildConversationsRouter());
  app.use('/api/chat', buildChatRouter());
  app.use('/api/usage', buildUsageRouter());
  app.use('/api/settings', buildSettingsRouter());
  app.use('/api/catalog', buildCatalogRouter());
  app.use('/api/admin', buildAdminRouter());

  // ---- 健康检查（无需认证）----
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    try {
      const { query } = require('./db/pool');
      await query('SELECT 1');
      res.json({ db: 'ok' });
    } catch (e) {
      res.status(503).json({ db: 'unavailable' });
    }
  });

  // ---- 静态托管前端 ----
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));
  // SPA 回退：非 /api 路由一律 index.html
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ---- /api 404 ----
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'notfound', message: '接口不存在' } }));

  // ---- 统一错误处理（不泄堆栈）----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error('[unhandled]', err && err.stack || err);
    res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
  });

  return app;
}

module.exports = { createApp };
