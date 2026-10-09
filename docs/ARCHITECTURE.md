# 架构说明（AI Universe Backend）

本文描述系统的真实运行机制、关键取舍与边界。接口字段见 [API.md](API.md)，部署见 [../README.md](../README.md) 与 [DEPLOY_PLATFORMS.md](DEPLOY_PLATFORMS.md)。

---

## 1. 三层适配器架构

系统严格分为三层，避免供应商协议细节泄漏到业务代码：

```
应用接口层（统一 DTO）
  ChatRequest / ChatMessage / ChatPart / ChatChunk / Usage
        │  只与统一对象打交道，不含任何供应商专有字段
        ▼
供应商适配器层（src/adapters/*.js，每家一个文件）
  请求转换 buildRequest()   ：ChatRequest -> 供应商原生请求体/头/URL
  流式解析 parseStream()    ：供应商 SSE/JSON 流 -> 统一 ChatChunk 序列
  错误映射 mapError()       ：供应商状态码/错误体 -> AppError(code, retryable)
  能力声明 capabilitiesFor()：按模型返回能力（流式/工具/视觉/思考链/结构化/窗口）
  用量提取 extractUsage()   ：供应商响应 -> {promptTokens, completionTokens, ...}
        │
        ▼
底层 HTTP 传输层（src/transport/）
  httpClient.safeFetch / createSafeClient：undici Agent + SSRF 守卫
  统一：连接/DNS 校验、超时、AbortSignal 取消、3xx 手动跟随（逐跳 SSRF）、
        X-Request-ID 注入、危险头剥除、429/5xx/网络错退避重试
  sse.pumpSSE：按行/空行切分 SSE，回调 onLine / onEvent
```

**8 家适配器**：`openai / anthropic / gemini / deepseek / qwen / zhipu / doubao / kimi`，由 `registry.js` 懒加载（`getAdapter(provider)`）。另有 `custom_openai_compatible.js`：构造时注入 `{baseUrl, apiKey, capabilities}`，用于用户自定义 OpenAI 兼容端点，**不进** registry。

关键原则：**OpenAI 兼容 ≠ 全功能一致**。DeepSeek、Qwen、智谱、豆包、Kimi 虽多为 OpenAI 兼容协议，但各自独立实现，分别处理：思考链字段（`reasoning_content` / `reasoning`）、能力差异（Kimi 无工具/视觉/结构化）、缓存 token 字段、错误体差异（`type`/`code`）、默认 Base URL 与端点。

### 适配器统一方法签名

| 方法 | 输入 | 输出 |
|---|---|---|
| `capabilitiesFor(providerModel)` | 供应商原生模型 slug | 能力对象（按模型区分） |
| `buildRequest({model, messages, apiKey, baseUrl, tools, ...})` | 统一 ChatRequest | `{url, method, headers, body}` |
| `parseStream(response, {signal})` | 上游响应（web ReadableStream） | async generator，yield 统一 ChatChunk |
| `mapError(status, body)` | 状态码 + 错误体 | `AppError`（含 code / retryable / status） |
| `extractUsage(responseBody)` | 上游响应/末帧 | 用量对象或 `null`（交核心估算） |

`parseStream` 内部把 `pumpSSE` 的同步回调模型桥接为 async generator（回调期收集 chunk、生成器顺序 yield），保证顺序与终止语义。

---

## 2. 请求生命周期（一次聊天）

```
POST /api/conversations/:id/messages   （Idempotency-Key 头）
  1) 限流 / 认证中间件
  2) 幂等检查（idempotency_keys）：
       命中且已完成 -> 直接重放已有事件序列（不新建任务）
       命中且运行中 -> 挂接到同一任务
  3) 写 user 消息（messages + message_parts）
  4) 建 generation_jobs，状态 queued -> running
  5) 解析模型（resolveModel：models JOIN model_capabilities）
  6) 取该用户该供应商的解密凭证；无凭证 -> 服务端 demoAdapter
  7) 上下文管理器 buildMessages（Token 预算）
  8) 适配器 buildRequest -> transport.safeFetch（SSRF/超时/取消）
  9) 适配器 parseStream：逐 chunk
       textDelta/reasoningDelta -> 写 message_parts、SSE 推给前端
       上游报错/中断 -> 状态机 failed/cancelled/interrupted
 10) 用量：extractUsage，缺失则按文本保守估算
 11) 计费：整数 costMicro，写 usage_records；预算检查
 12) 状态机 -> completed，SSE done
```

SSE 采用**惰性写头**：只有产生首个事件时才写 `text/event-stream` 头，因此前置校验失败（4xx）仍以 JSON 错误返回，而不是给前端一个已成功的流。

---

## 3. 消息状态机

状态：`queued / running / completed / failed / cancelled / interrupted`

```
queued      -> running
running     -> completed | failed | cancelled | interrupted
interrupted -> completed | failed
failed      -> queued      # 仅当错误可重试且自动重试次数未超上限（由调用方判定）
completed / cancelled      # 终态
```

非法转换抛 `AppError('conflict')`（HTTP 409）；同态转换视为幂等空操作。

**取消语义**（`POST /api/chat/jobs/:id/cancel`）需区分三种情况：
- 取消是否已被上游确认；
- 上游连接是否已关闭；
- 在取消时点用量是否仍可获取（可取则按实际 completion 计费，否则按已交付增量估算）。

`interrupted` 表示流被意外打断（连接中断等），可恢复后继续到 completed/failed。

---

## 4. 幂等

- 每个写请求带 `Idempotency-Key`，持久化在 PostgreSQL `idempotency_keys`（**非内存**，多实例/重启后仍有效）。
- 重复提交：返回/重放已有任务的事件序列，而**非新建**（E2E 已验证同 key 重发仅产生 1 个 assistant 消息）。
- 用量记录 `recordUsage` 同样按 idempotency key 去重，防止重复计费。

---

## 5. 上下文管理器（Token 预算）

`buildMessages({systemText, history, newUserParts, capabilities})`：

1. 读取模型 `contextWindow` 与 `maxOutputTokens`，输出预留 `reserveOutput = round(maxOut × 1.1)`；
2. **系统安全指令固定预算、永不裁剪、置于最前**；
3. `available = contextWindow − systemTokens − reserveOutput − newUserTokens`；
4. 从**最近历史向前**累加直到 `available` 用尽，更早历史丢弃；
5. **tool_call 与 tool_result 成对保留**，禁止拆开；
6. **不按字符硬截断**，全部基于 token 估算；
7. 至少保留一条最近历史，避免历史被完全清空。

**超限自动压缩重试一次**：上游返回上下文长度错误时，用 `compressedMessages()`（系统指令 + 摘要占位 + 最近 4 轮）重试一次；仍失败则报错，不无限重试。

多部分 token 口径：文本/思考链/拒答按 `estimateTokens`；`tool_call` 按 name+args；`tool_result` 按内容；图片约 1200 token/张。

---

## 6. 多部分消息

统一 `ChatPart.type`：`text / reasoning / tool_call / tool_result / image / attachment / refusal`。

- 一条消息由多个有序 part 组成（存 `message_parts`，含 seq）；
- `reasoning` 渲染为可折叠思考块；`tool_call/tool_result` 渲染为工具卡片；`image/attachment` 渲染为缩略/附件 chip；`refusal` 表示模型拒答。

---

## 7. 自动路由

三种模式：**手动 manual / 推荐 recommend / 自动 auto**。

自动模式流程：

```
classifyTask(最近用户文本) -> 任务类别（coding/writing/vision/reasoning/chitchat/...）
过滤候选模型（全部需同时满足）：
  - 能力匹配（如 vision 任务淘汰无视觉模型）
  - 该用户已配置凭证（demo 模式免凭证）
  - 模型/供应商未停用、未熔断
  - 上下文窗口装得下
  - 估算费用 ≤ 每任务预算（perTask = 每日预算 × 0.2）
打分：score = fit − 成本项 − 延迟项
  fitScore：能力契合度；超大上下文（>500k）适度扣分；coding 偏好 struct+tools
autoSelect：取得分最高者
```

**不可逆副作用保护**：`hasIrreversibleSideEffect` 检测工具调用等不可逆操作；仅当**无不可逆副作用**时，自动模式才允许自动重试/切换模型，防止工具被重复执行。路由决策写入 `audit_logs(routing_decision)`。

---

## 8. 计费与用量

- **整数 micro**：1 元 = 1,000,000；价格以 micro/百万 token 整数存储，全链路禁用浮点。
- 成本：`costMicro = Math.floor(tok × priceMicroPerMtok / 1e6)`，**输入/输出分别 floor 后整数相加**（避免浮点误差）。
- **价格版本化**：`pricing_versions` 按时间区间取价（`effective_from ≤ at` 且 `effective_to IS NULL 或 > at`），禁止用现价回溯历史。
  - 迁移 `002_pricing_version_history.sql` 把最初的「全列 UNIQUE(provider,model)」改为「`WHERE effective_to IS NULL` 的部分唯一索引」，从而支持调价历史且当前价唯一。
- **用量缺失估算**：供应商未回传 usage 时，`estimateTokens` 按文本保守估算（CJK ≈ 1.5 token/字，其余 ≈ 1 token/4 字符，ceil）。
- **部分失败**按实际 completion 计费；重复请求去重。
- **预算与限额**：每分钟、每日、单任务预算、并发上限；超预算拒绝；管理员可全局只读/紧急停用。
- demo 模式不写 `usage_records`，cost = 0。

---

## 9. 安全设计

### 9.1 凭证加密（KMS）

- AES-256-GCM，密文 `v1:<keyId>:<b64 nonce>:<b64 data>:<b64 tag>`，随机 nonce；
- 主密钥仅来自环境变量（`MASTER_ENCRYPTION_KEY` / `MASTER_ENCRYPTION_KEYS`），**绝不入库、不入日志、不提交仓库**；
- **轮换**：`MASTER_ENCRYPTION_KEYS` 可含多个 key，当前 `ENCRYPTION_KEY_ID` 用于加密，旧 key 仅用于解密；
- 接口只回掩码（前 4 后 4，如 `sk-l***cdef`），更换时不回显旧值；支持删除。

### 9.2 SSRF 守卫（自定义 Base URL）

- 仅允许 `https`（`allowInsecure` 仅供测试注入）；
- 默认拒绝：回环/私网/保留/链路本地/云元数据 —— `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10`、v4-mapped 地址等；
- **连接时校验**：undici `connect.lookup = guardedLookup`，在真正建连的 IP 上校验，防 DNS 重绑定（解析通过、连接时切换到内网）；
- 3xx 重定向**逐跳重新校验**（`maxRedirections:0` 手动跟随）；
- 剥除 `host`、`x-forwarded-*` 等危险头。

### 9.3 认证与限流

- 密码 bcrypt（cost 10）；JWT access（默认 15m）+ refresh（默认 7d）；
- 刷新会话仅以 **sha256 哈希**存于 `user_sessions`，经 httpOnly cookie `au_refresh` 下发，可逐个/全部撤销；
- 登录失败 5 次锁定 15 分钟；
- 限流为**进程内滑动窗口**（`rateLimit.js`），登录与 API 分别限流；
- 统一错误处理不泄露堆栈；`redact.js` 对日志中的 key/token/cookie/password 递归打码。

---

## 10. 传输层

- undici Agent：统一连接、keep-alive、严格超时；
- 外部 `AbortSignal` 与内部超时信号合并，取消立即生效；
- 每请求注入 `X-Request-ID`，便于追踪；
- 429 / 5xx / 网络错误最多退避重试 2 次（SSRF 拒绝、4xx 不重试）；
- `pumpSSE` 同时兼容 Node `Buffer`、web ReadableStream 的 `Uint8Array` 与字符串。

---

## 11. 数据库模式（PostgreSQL）

迁移文件可重复执行（`schema_migrations` 记录，每文件单事务，已应用跳过）。共 20 张表，分组：

| 分组 | 表 |
|---|---|
| 身份/会话 | `users`、`user_sessions` |
| 对话 | `conversations`、`messages`、`message_parts`、`message_branches` |
| 生成 | `generation_jobs`、`generation_events` |
| 模型目录 | `providers`、`provider_credentials`、`models`、`model_capabilities` |
| 资产/工具 | `attachments`、`tool_calls` |
| 计费 | `usage_records`、`pricing_versions` |
| 配置/审计 | `prompt_templates`、`user_settings`、`idempotency_keys`、`audit_logs` |

约定：TEXT 主键（`usr_/cvs_/msg_/mdl_/...`）、TIMESTAMPTZ、金额 BIGINT（micro）、复杂结构 JSONB；索引覆盖外键与高频查询。启动时种子化 **8 供应商 / 24 模型 / 24 能力 / 24 价格**，默认模型为 `gpt-4o-mini`（`is_default`）。

**ID 口径**：DB `models.id = mdl_<目录id>`（如 `mdl_gpt-4o-mini`），catalog 与 `conversations.model_id` 全程使用 `mdl_` id；供应商原生模型名在 `models.slug`。

---

## 12. 并发与进程模型

- 聊天引擎为**单例**（`app.locals.chatService`），内存实时流注册表在实例内；
- 每用户并发任务受 `MAX_CONCURRENT_JOBS` 约束；
- 启动自动迁移/种子为幂等操作，**单实例**免费档安全；
- 若水平扩展到多实例：
  - 幂等与业务数据已在 PostgreSQL，天然共享；
  - **进程内限流**与内存实时流注册表需替换为 Render Redis / PG 方案（当前明确限制，见 README）。

---

## 13. 已知边界（如实）

1. Render 免费 Web 休眠冷启动；免费托管 Postgres 政策收紧时可换 Neon（仅改 `DATABASE_URL`）。
2. 海外节点与国内供应商互访可能慢，建议新加坡区域。
3. 真实联网搜索/工具执行需对应 Key 或后端工具能力；多模型协作列为后续。
4. 价格为近似参考，实际以供应商账单为准；demo 内容为占位，不代表真实模型能力。
