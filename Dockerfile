# ============================================================
# AI Universe 后端 —— 多阶段生产镜像
# 基础镜像：node:20-alpine（与 package.json engines.node >=20 对齐）
# 构建：docker build -t ai-universe-backend .
# ============================================================

# ---------- Stage 1：安装（仅生产依赖） ----------
FROM node:20-alpine AS deps
WORKDIR /app

# 先只拷贝依赖清单，利用 Docker 层缓存：依赖不变就不重装
COPY package*.json ./
# 有 lockfile 用 npm ci（可复现），没有则退回 npm install
RUN npm ci --omit=dev || npm install --omit=dev

# ---------- Stage 2：运行 ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production
# Render 会在运行时注入 PORT；本地/容器内默认 8080
ENV PORT=8080
# 启动时自动跑幂等迁移与模型目录种子（生产已由 render.yaml 注入）
ENV RUN_MIGRATE=true
ENV RUN_SEED=true

WORKDIR /app

# 非 root 运行，降低容器逃逸面
RUN addgroup -S app && adduser -S app -G app

# 只拷入运行所需产物：依赖、清单、源码、托管的静态前端
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package*.json ./
COPY --chown=app:app src ./src

USER app

EXPOSE 8080

# Render / 本地 docker 统一入口；进程直接由 node 运行，
# 不使用 npm start 包装（避免信号转发问题导致优雅退出失效）
CMD ["node", "src/server.js"]
