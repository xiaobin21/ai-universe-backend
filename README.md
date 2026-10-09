# AI Universe · 多模型 AI 助手（完整产品后端）

一个账号、一个网页，统一调用 **8 家供应商、24 个模型**。本仓库把原纯前端 H5 升级为**可在海外免运维 PaaS（以 Render 为主）一键部署的完整产品后端**：用户注册登录、每用户加密密钥、对话与用量入库、多模型流式代理、自动路由、上下文管理、整数计费、SSRF 守卫，并内置与 API 打通的托管手机网页。

- **技术栈**：Node.js 20+ / Express 4（原生 CommonJS，无 TypeScript、无重型框架）、PostgreSQL
- **部署**：Render Blueprint（Web Service + 托管 PostgreSQL），附 Railway / Fly.io 等价说明
- **供应商**：OpenAI、Anthropic（Claude）、Gemini、DeepSeek、通义 Qwen、智谱 GLM、豆包 Doubao、Kimi

> 本仓库**不包含也不需要**任何预置密钥；未配置 Key 时自动进入「服务端演示模式」，可端到端体验完整流式链路且不产生费用。

---

## 一、功能一览

| 模块 | 能力 |
|---|---|
| 三层适配器 | 统一应用接口 → 供应商适配器 → 底层 HTTP（统一超时/取消/连接/追踪）。8 家各自独立实现请求转换、流式解析、错误码映射、能力声明、用量提取、取消与超时，均带单测 |
| 认证 | 邮箱注册/登录（bcrypt 哈希）、JWT 访问令牌 + 可撤销刷新会话、失败锁定、登录/接口限流 |
| 密钥安全 | 凭证服务端 **AES-256-GCM** 加密存储；主密钥仅来自环境变量；支持轮换与删除；接口永不回显完整密钥 |
| SSRF 守卫 | 自定义 Base URL 仅允许 https；默认拒绝本机/内网/链路本地/云元数据地址；校验 DNS 解析、重定向逐跳重校、严格超时（防 DNS 重绑定） |
| 聊天核心 | 消息状态机、SSE 流式输出与取消、请求幂等键、上下文 Token 预算与自动压缩、多部分消息（text/reasoning/tool_call/tool_result/image/attachment/refusal） |
| 自动路由 | 手动 / 推荐 / 自动三模式；自动模式按「任务分类 → 能力/凭证/上下文/预算过滤 → 打分（fit−成本−延迟）」；仅在无不可逆副作用时才自动重试/切换 |
| 计费用量 | 供应商未回传用量时按文本保守估算；金额一律**整数 micro**（1 元 = 1,000,000，禁用浮点）；价格版本化；每用户每分钟/每日/单任务预算与并发上限；管理员紧急停用 |
| 托管网页 | Express 托管与 API 打通的手机网页，保留原 H5 视觉与多部分渲染；未登录显示登录/注册 |

---

## 二、架构总览

```
                          浏览器（src/public/index.html 托管手机网页）
                            │  HTTPS：REST(/api/*) + SSE
                            ▼
                    ┌──────────────────────┐
                    │  Express 应用层       │  helmet / CORS / 限流 / 认证中间件
                    │  routes → services   │
                    └──────────┬───────────┘
                               │
   ┌───────────────┬───────────┼────────────┬───────────────┐
   ▼               ▼           ▼            ▼               ▼
 认证/会话      凭证(KMS)   聊天引擎      自动路由        计费/预算
 auth/         credentials chat.service  routing         billing
   │               │           │            │               │
   │               │           ▼            │               │
   │               │   ┌────────────────────┴──────┐        │
   │               │   │ 上下文管理器(Token 预算)    │        │
   │               │   │ 消息状态机 / 幂等 / 演示    │        │
   │               │   └──────────────┬────────────┘        │
   │               │                  ▼                     │
   │               │        ┌───────────────────┐            │
   │               │        │ 供应商适配器层(8家) │            │
   │               │        │ 转换/流式/错误/用量 │            │
   │               │        └─────────┬─────────┘            │
   │               │                  ▼                      │
   │               │        ┌───────────────────┐            │
   └───────────────┴────────│ 底层 HTTP 传输层    │────────────┘
                            │ undici + SSRF 守卫  │
                            │ 超时/取消/重试/追踪  │
                            └─────────┬─────────┘
                                      ▼  仅 https
                          OpenAI / Anthropic / Gemini / DeepSeek
                          Qwen / 智谱 / 豆包 / Kimi（或自定义 Base URL）

      PostgreSQL（迁移 + 种子）：users / sessions / conversations / messages /
      message_parts / generation_jobs / provider_credentials / models /
      model_capabilities / usage_records / pricing_versions / audit_logs …
```

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，接口见 [`docs/API.md`](docs/API.md)。

### 目录结构

```
ai-universe-backend/
├── src/
│   ├── config.js                 # 环境变量集中读取 + 生产 fail-fast
│   ├── app.js / server.js        # Express 装配 / 启动（含健康检查、静态托管）
│   ├── transport/                # httpClient（undici+SSRF）/ sse（pumpSSE）
│   ├── adapters/                 # base/registry + 8 家适配器 + custom + samples/
│   ├── core/
│   │   ├── security/             # crypto / ssrf / redact / rateLimit
│   │   ├── auth/  credentials/   # 认证会话 / 凭证加解密
│   │   ├── chat/  context/       # 聊天引擎/状态机/幂等/演示 + 上下文管理
│   │   ├── billing/ routing/     # token 估算/价格/用量/预算 + 自动路由
│   ├── db/                       # pool / migrate / seed + migrations/
│   ├── routes/                   # 8 组 REST 路由
│   └── public/index.html         # 托管手机网页（单文件）
├── test/                         # 单测 + 集成测试（node:test，mock 上游）
├── scripts/local-pg.js           # 免 root 本地 PostgreSQL（embedded-postgres）
├── Dockerfile / .dockerignore
├── docker-compose.yml            # 本地开发：app + postgres:16-alpine
├── render.yaml                   # Render Blueprint：web + postgres
└── .env.example
```

---

## 三、本地启动

### 方式 A：Docker Compose（推荐，最贴近生产）

前置：已安装 Docker / Docker Compose。

```bash
cd ai-universe-backend
docker compose up --build
# 打开 http://localhost:8080
```

`docker-compose.yml` 会同时启动 **app** 与 **postgres:16-alpine**（带健康检查、数据卷、源码热挂载），app 启动时自动执行迁移与种子。

### 方式 B：免 Docker（本机无 Docker / 无系统 PostgreSQL）

本仓库用 devDependency `embedded-postgres` 提供免 root 的真实 PostgreSQL（仅用于本地/测试）。

```bash
cd ai-universe-backend
npm install

# 1) 启动本地 PostgreSQL（默认 127.0.0.1:55432，库名 aiuniverse）
node scripts/local-pg.js          # 保持该终端运行

# 2) 另开终端：配置连接串、迁移、种子
export DATABASE_URL="postgres://aiuniverse:aiuniverse@127.0.0.1:55432/aiuniverse"
cp .env.example .env              # 编辑 .env，填入随机 MASTER_ENCRYPTION_KEY / JWT_SECRET
npm run migrate
npm run seed

# 3) 启动服务
npm start                         # 默认端口 8080，可用 PORT=xxxx 覆盖
```

健康检查：

```bash
curl http://localhost:8080/healthz   # {"status":"ok"}
curl http://localhost:8080/readyz    # {"db":"ok"}
```

> 若本机 8080 被占用，用 `PORT=18080 npm start` 指定其他端口。

---

## 四、环境变量

完整清单见 [`.env.example`](.env.example)。**核心变量**：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL 连接串。Render 由蓝图自动注入托管库连接串 |
| `MASTER_ENCRYPTION_KEY` | ✅ | 凭证主密钥（32 字节，建议 base64）。仅用于加解密，**绝不入库/入日志/提交仓库** |
| `ENCRYPTION_KEY_ID` | ✅ | 当前主密钥 id（如 `k1`），用于密文版本标记 |
| `MASTER_ENCRYPTION_KEYS` | 轮换 | 多密钥映射，如 `k1:<base64>,k2:<base64>`；旧 key 仅用于解密 |
| `JWT_SECRET` | ✅ | JWT 签名密钥（随机长字符串） |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL_DAYS` | | 访问令牌 / 刷新会话有效期（默认 15m / 7d） |
| `RUN_MIGRATE` / `RUN_SEED` | | 启动时是否自动迁移/种子（默认 true） |
| `DB_SSL` | | `auto`（生产自动开 SSL，本地关）/ `true` / `false` |
| `DEFAULT_DAILY_BUDGET_MICRO` | | 新用户每日预算（micro，默认 10 元 = 10,000,000） |
| `MAX_CONCURRENT_JOBS` | | 每用户并发生成任务上限（默认 3） |
| `RATE_LIMIT_API_PER_MIN` | | 接口每分钟限流（默认 60） |
| `CORS_ORIGINS` | | 显式允许的前端来源（逗号分隔）；默认开发放开、生产同源 |
| `OPENAI_API_KEY` 等 | 可选 | 平台级供应商 Key（普通用户仍可在「设置→模型密钥」填自己的 Key） |

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # MASTER_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # JWT_SECRET
```

---

## 五、一键部署到 Render

> 最终部署需要**你自己的 Render 账号**（连接 GitHub，或使用 Render CLI/Token）。本仓库无法、也不会登录你的云账号或动用计费。

### 0) 把仓库推到你自己的 GitHub

```bash
# 在你自己的 GitHub 新建空仓库 ai-universe-backend 后：
git init && git add . && git commit -m "AI Universe backend"
git branch -M main
git remote add origin https://github.com/<你的用户名>/ai-universe-backend.git
git push -u origin main
```

### 1) Blueprint 一键部署（推荐）

把下面按钮链接里的 `YOUR_REPO_URL` 替换为你的仓库地址后打开，或在 Render Dashboard 选择 **New → Blueprint**，授权并选中该仓库（读取根目录 `render.yaml`）：

```
https://render.com/deploy?repo=YOUR_REPO_URL
```

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=YOUR_REPO_URL)

蓝图会自动创建：

- **Web Service**：Docker 运行时、免费实例、健康检查路径 `/healthz`、自动部署；
- **PostgreSQL**：托管数据库，`DATABASE_URL` 自动注入；
- **密钥**：`MASTER_ENCRYPTION_KEY`、`JWT_SECRET` 由 Render 自动生成（`generateValue`，不回显），`ENCRYPTION_KEY_ID=k1`。

服务启动时自动执行**迁移 + 种子**（幂等，单实例免费档安全）。部署完成后打开 Render 分配的 `https://<service>.onrender.com`。

### 2) Render CLI / Token 流程

```bash
# 安装并登录（https://render.com/docs/cli）
render login
render sync        # 在仓库根目录按 render.yaml 创建/更新资源
# 或：render deploys create <service-name>
```

### 其他平台

Railway、Fly.io 的等价配置与步骤见 [`docs/DEPLOY_PLATFORMS.md`](docs/DEPLOY_PLATFORMS.md)。

---

## 六、测试

```bash
npm test               # 全部单测 + 集成测试（自动起内嵌 PostgreSQL，mock 上游，不触网/不扣费）
npm run test:unit      # 仅适配器/加密/SSRF/路由/上下文/计费等单测
npm run test:integration   # DB / 认证 / 流式代理集成测试
```

覆盖：8 家适配器（转换/流式/错误/用量/能力）、AES-256-GCM、SSRF（含 DNS 重绑定/重定向）、自动路由、上下文裁剪、整数计费，以及认证、流式代理的关键集成链路。

---

## 七、安全说明

- **凭证加密**：用户供应商 Key 使用 AES-256-GCM 加密后入库，密文格式 `v1:<keyId>:<nonce>:<data>:<tag>`；任何列表/详情接口只返回前 4 后 4 的掩码（如 `sk-l***cdef`），更换时不回显旧值。
- **主密钥管理**：主密钥只来自环境变量/平台密钥管理，支持密钥轮换（旧 key 仅解密）与凭证删除。
- **SSRF 防护**：自定义 Base URL 强制 https，默认拒绝回环/私网/链路本地/云元数据（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7` 等），连接时校验解析 IP 防 DNS 重绑定，3xx 重定向逐跳重新校验。
- **认证安全**：bcrypt 哈希、刷新会话仅存哈希、可撤销、失败锁定、登录与接口限流；统一错误处理不泄露堆栈。
- 关键安全事件写入 `audit_logs`。

---

## 八、如实的限制（请先阅读）

1. **Render 免费 Web 服务会休眠**：约 15 分钟无请求后休眠，下次请求有冷启动延迟（数十秒）。需要常驻请升级付费实例。
2. **Render 托管 PostgreSQL 免费政策收紧**：如免费库不可用，可一键切换到 **Neon 免费 Serverless PostgreSQL**——只需替换 `DATABASE_URL`，其余不变。
3. **网络可达性**：Render 多为美国节点，直连国内供应商（豆包/通义/智谱/Kimi/DeepSeek）可能较慢；可在创建蓝图时选择**新加坡区域**改善。
4. **限流为进程内实现**：当前无 Redis，限流器在单实例内有效；多实例/多副本水平扩展时，需改为 Render Redis 或数据库限流（幂等已持久化在 PostgreSQL，不受影响）。
5. **真实联网搜索 / 工具执行**：需要对应的搜索 API Key 或后端工具能力；当前以多部分消息中的 `tool_call/tool_result` 结构承载与渲染，真实工具执行需按供应商能力开通。
6. **多模型协作（编排多个模型共同完成一个任务）**：状态机与数据结构已预留，可作为后续迭代项。
7. 模型价格为**近似人民币参考价**，以 `pricing_versions` 版本化存储；实际费用以供应商账单为准。

---

## 九、许可证

MIT。详见 [LICENSE](LICENSE)。
