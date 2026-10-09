# 部署指引 —— 海外免运维 PaaS（Render 为主）

本项目是 **Node.js (Express) + PostgreSQL** 后端，前端静态页由同一服务托管。
推荐用 **Render** 一键部署；下文也附 Railway / Fly.io 的等价做法。

> 前提：你需要把本仓库推到自己的 GitHub/GitLab 账号（Render 免费账户即可），
> 并在 Render 完成最后一步「Deploy」。我无法代你登录云账号或动用你的计费。

---

## 0. 架构与运行单元

| 组件 | 说明 |
|---|---|
| Web 服务 | 一个 Docker 容器（`Dockerfile` 多阶段构建，`node:20-alpine`），监听平台注入的 `PORT` |
| 数据库 | 托管 PostgreSQL（Render 托管库 / Neon 均兼容） |
| 健康检查 | `GET /healthz`（存活）、`GET /readyz`（就绪） |
| 迁移 | 容器启动时自动执行 `npm run migrate`（迁移文件幂等），再 `npm run seed` 幂等写入 8 家 24 模型目录 |

迁移放在「启动时执行」而非 Render 的 `releaseCommand`，是因为 **Render 的 `releaseCommand` 只对原生运行时（node/python 等）生效，Docker 运行时不支持**；启动迁移是单实例免费档最稳妥的做法。若日后升到多实例，应把迁移改为一次性 Job / 独立 release 步骤，避免并发迁移。

---

## 1. Render 一键部署（推荐）

### 1.1 准备

1. 把本仓库推到你自己的 GitHub（私有仓库即可）：
   ```bash
   cd ai-universe-backend
   git init && git add . && git commit -m "init"
   git remote add origin git@github.com:<你的账号>/ai-universe-backend.git
   git push -u origin main
   ```
   确认 **不要**把 `.env` 推上去（已在 `.gitignore` 中）。

### 1.2 方式 A：Deploy to Render 按钮（最省事）

在你的 README / 任何 Markdown 里放一行：

```markdown
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=YOUR_REPO_URL)
```

把 `YOUR_REPO_URL` 换成你仓库地址，例如
`https://github.com/<你的账号>/ai-universe-backend`。

点开按钮后：
1. Render 自动读取仓库根目录的 `render.yaml`（Blueprint）；
2. 它会询问是否自动创建 **PostgreSQL 数据库** 与 **Web 服务**，确认即可；
3. `MASTER_ENCRYPTION_KEY`、`JWT_SECRET` 会被 Render 自动生成并保管（`generateValue: true`，不进仓库）；
4. 等待构建完成，访问分配的 `https://<service>.onrender.com/healthz` 应返回 200。

### 1.3 方式 B：Dashboard 手动导入 Blueprint

1. 登录 <https://dashboard.render.com> → **New +** → **Blueprint**；
2. 选你的仓库（首次需授权 Render 访问 GitHub）；
3. Render 自动识别 `render.yaml`，预览出一个 Web 服务 + 一个 PostgreSQL；
4. 点 **Apply**，等待首次构建（约 2–5 分钟）。

### 1.4 方式 C：Render CLI / Token（适合脚本化）

```bash
# 安装 CLI
npm install -g render-cli

# 登录（浏览器授权）
render login

# 用仓库根的 render.yaml 创建 Blueprint 实例
render blueprint apply --repo git@github.com:<你的账号>/ai-universe-backend.git

# 查看状态 / 日志
render services
render logs <service-id>
```

无头/CI 环境可用 API Token：在 Dashboard → **Account Settings → API Keys** 生成，
然后 `export RENDER_API_KEY=...`，CLI 与 `render.yaml` 配合即可自动创建。

---

## 2. 部署后必做

1. 打开 `https://<你的服务>.onrender.com/healthz`，应返回 `{"status":"ok"}` 之类。
2. 注册第一个账号。若要把它设为管理员，在 Render 后台给服务加环境变量
   `ADMIN_BOOTSTRAP_EMAIL=你注册的邮箱`，重启一次即可。
3. （可选）在前端「设置 → 供应商 Key」里绑定你自己的 OpenAI / Anthropic / 豆包等 Key；
   这些 Key 在服务端用 `MASTER_ENCRYPTION_KEY` 做 AES-256-GCM 加密落库，**永远不会回显完整值**。
4. 若要平台统一出账（用户免填 Key），在 Render 后台把 `OPENAI_API_KEY` 等对应变量填上即可。

---

## 3. 已知限制（如实说明，勿夸大）

- **免费 Web 服务会休眠**：Render 免费档 15 分钟无流量即挂起，下次请求冷启动约 10–30 秒。要持续运行需升 Starter（$7/月起）。
- **Render 托管 PostgreSQL 免费政策已收紧**：免费库常为短期试用或直接转为付费。两个替代方案：
  1. **Neon 免费 Serverless Postgres**（推荐）：去 <https://neon.tech> 建库，拿到
     `postgresql://user:pass@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`，
     在 Render 后台把 Web 服务的 `DATABASE_URL` 从「自动 fromDatabase」改为该固定值，
     **其余配置一行不改**，同时可删掉 `render.yaml` 里的 `databases:` 段。
  2. Supabase / Supabase 免费 Postgres、Turso 等，思路相同。
- **跨境网络可达性**：Render 默认区域在美国（oregon）。**从美国服务器直连国内供应商**
  （豆包 / 通义 / 智谱 / Kimi / DeepSeek）可能延迟高、偶发超时；反过来从中国大陆
  访问 Render 的 `.onrender.com` 也可能不稳定。
  - 若以国内供应商为主，建议把 Render 服务放到 `singapore` 区域，或考虑下文 Railway / Fly.io 亚洲节点。
- **未实现的能力**：真实联网搜索、工具执行（function calling 落地执行）、多模型协作编排
  属于后续路线图；当前工具调用仅做声明与多部分消息记录，不会真实调用外部工具。
- **免费档并发**：单实例、每用户默认 3 路并发生成（`MAX_CONCURRENT_JOBS`）。

---

## 4. 本地开发（不改云端）

```bash
cp .env.example .env
# 生成两个必填密钥
node -e "console.log('MASTER_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))" >> .env
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('base64'))" >> .env

docker compose up --build
# 另开终端
curl http://localhost:8080/healthz
```

无 Docker 时也可本地直跑：本地装一个 Postgres，把 `.env` 里的 `DATABASE_URL` 指向它，
`npm install && npm run migrate && npm run seed && npm run dev`。

---

## 5. Railway 等价部署（简要）

Railway 与 Render 类似，自动识别 Dockerfile：

1. 推仓库到 GitHub；
2. <https://railway.app> → **New Project** → **Deploy from GitHub repo**；
3. 加一个 **Database → PostgreSQL** 插件；
4. 在服务的 Variables 里填入：
   - `DATABASE_URL` = 引用 Postgres 插件的 `DATABASE_URL`（Railway 会自动注入 `postgres.railway.internal`）
   - `MASTER_ENCRYPTION_KEY`、`JWT_SECRET`（用它的 **Raw / Generate** 按钮生成）
   - `NODE_ENV=production`、`RUN_MIGRATE=true`、`RUN_SEED=true`
5. Railway 默认自动检测 `Dockerfile`，无需额外配置；健康检查在 Settings 里设 `/healthz`。

> Railway 无「免费长期额度」概念，按用量计费，试用额度通常够个人跑通。

---

## 6. Fly.io 等价部署（简要）

Fly.io 用一个 `fly.toml`（本仓库未内置，按需新增）：

```toml
app = "ai-universe-backend"
primary_region = "hkg"            # 香港，离国内供应商更近

[build]
  dockerfile = "./Dockerfile"

[env]
  NODE_ENV = "production"
  RUN_MIGRATE = "true"
  RUN_SEED = "true"

[[services]]
  internal_port = 8080
  [services.http_checks]
    interval = "10s"
    timeout = "2s"
    method = "get"
    path = "/healthz"
```

然后：

```bash
flyctl launch            # 首次，选本机已生成的 Dockerfile
flyctl postgres create   # 建托管 Postgres
flyctl secrets set \
  DATABASE_URL="postgres://..." \
  MASTER_ENCRYPTION_KEY="..." \
  JWT_SECRET="..."
flyctl deploy
```

Fly.io 支持按秒计费、小规格 VM，香港/东京节点对国内供应商延迟比美国 Render 小很多；
但需要 `flyctl` 登录与 `fly.toml` 维护，没有 Render Blueprint 那种「一个 YAML 全自动」的体验。

---

## 7. 常用运维命令（Render）

| 操作 | 路径 |
|---|---|
| 看日志 | Dashboard → 你的 Web 服务 → Logs |
| 重启 | 右上角 **Manual Deploy → Clear build cache & deploy** 旁的 Restart |
| 改环境变量 | 服务 → **Environment** 标签 |
| 紧急只读停服 | 加环境变量 `GLOBAL_READONLY=true` 并重启（不删数据） |
| 查库 | Render 数据库页 → **Connect** 拿 psql 连接串，本地 `psql` 直连调试 |
