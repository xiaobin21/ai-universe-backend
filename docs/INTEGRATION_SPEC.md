# AI Universe 后端 —— 集成契约（FROZEN，所有执行者必须遵守）

> 本文件是后端各模块之间的**唯一权威契约**。统一 DTO、适配器接口、传输层 API、REST/SSE 契约、DB 约定、金额规则均以本文为准。
> 与业务无关的供应商差异**只允许**出现在 `src/adapters/`；业务层禁止出现 `if (provider === 'xxx')`。
> 技术栈：Node.js (>=20) + Express 4 + PostgreSQL，**原生 CommonJS**（`require`，不用 TypeScript、不用 ESM import、不用 NestJS 等重型框架）。

---

## 0. 全局硬约定

1. **金额一律整数 micro**：`1 元 = 1_000_000 micro`。禁止用 float 存储/累加金额。
   - 价格以「micro / 百万 token」整数存储：`priceMicroPerMtok = round(元每百万token * 1e6)`。
   - 计费公式（纯整数）：`costMicro = Math.floor(tokens * priceMicroPerMtok / 1_000_000)`。
   - 输入、输出分别计算后**整数相加**。
2. **测试用 Node 内置 runner**：`node --test` + `node:assert/strict`，不引入 jest/mocha。测试**禁止真实扣费**，上游一律用录制样本 / 本地 mock http server。
3. **密钥三不**：不入库明文、不入日志、不回显完整值；响应只回显「前4后4」。
4. **出站请求必经传输层 `safeFetch`**（内含 SSRF 守卫），禁止业务代码直接 `fetch`/`http.request` 打外部地址。
5. **消息一律多部分**：assistant 内容由 `message_parts` 多行表达，禁止退化为单 `content TEXT`。
6. 统一错误类 `AppError`：`{ code, message, retryable, status?, provider? }`。统一错误码集合见 §7。
7. 所有异步可取消操作接收 `AbortSignal`；所有外部调用透传 `requestId`（注入 `X-Request-ID` 头）。
8. 配置从环境变量读取，集中在 `src/config.js`；启动时 fail-fast 校验 `DATABASE_URL`、`MASTER_ENCRYPTION_KEY`、`ENCRYPTION_KEY_ID`、`JWT_SECRET`（生产）缺失即拒绝启动并打印缺失项。

---

## 1. 统一应用 DTO（第一层）

业务层只允许出现以下结构（普通 JS 对象，字段名固定）：

```js
// 一次聊天请求（应用内部表示）
ChatRequest = {
  conversationId, model: { id, provider, providerModel /* 供应商原生模型名 */ },
  messages: [ ChatMessage ],          // 已由上下文管理器裁剪
  maxOutputTokens,                    // 已取「模型上限 vs 用户设置」较小值
  temperature?, tools?,               // 本期 tools 仅声明、不真实执行
  requestId, idempotencyKey, signal,
}

// 一条消息
ChatMessage = {
  role: 'system'|'user'|'assistant'|'tool',
  parts: [ ChatPart ],                // 多部分
}

// 消息部件（type 判别联合）
ChatPart =
  | { type:'text', text }
  | { type:'reasoning', text }                                   // 思考链，独立 part，禁止拼正文
  | { type:'tool_call', toolCallId, name, args/*object*/ }
  | { type:'tool_result', toolCallId, content, isError? }
  | { type:'image', mediaType?, dataBase64?, url? }              // 二选一：base64 或 url
  | { type:'attachment', name, sizeBytes, text? }
  | { type:'refusal', text }

// 流式增量（适配器 → 聊天核心）
ChatChunk =
  | { kind:'textDelta', text }
  | { kind:'reasoningDelta', text }
  | { kind:'toolCallDelta', toolCallId, name?, argsDelta? }
  | { kind:'usage', usage: Usage }
  | { kind:'done' }
  | { kind:'error', error: AppError }

// 用量
Usage = { promptTokens, completionTokens, totalTokens, usageSource: 'upstream'|'estimated' }

ChatResult = { text, parts: [ChatPart], usage: Usage, requestId?, stopReason? }
```

---

## 2. 适配器接口（第二层）

文件：`src/adapters/base.js` 导出 `BaseModelAdapter`（抽象基类 / 可直接被 extends）。
每家供应商一个独立文件：`openai.js / anthropic.js / gemini.js / deepseek.js / qwen.js / zhipu.js / doubao.js / kimi.js / custom_openai_compatible.js`，**禁止合并**。

每个适配器必须实现（方法名固定）：

```js
class XxxAdapter extends BaseModelAdapter {
  constructor() {
    super();
    this.provider = 'deepseek';                 // ProviderId，见 §8
  }
  /** 能力声明（也可由 DB model_capabilities 覆盖；适配器内给该供应商的默认/兜底声明） */
  capabilitiesFor(providerModel) -> ModelCapabilities
  /** 内部 ChatRequest -> { url, headers, body }（url 已含 base；body 为可 JSON.stringify 对象） */
  buildRequest(req) -> { url, headers, body }
  /** 解析上游响应流，async generator yield ChatChunk（统一） */
  async *parseStream(response, ctx) -> AsyncGenerator<ChatChunk>
  /** 非 2xx / 网络错误 -> AppError */
  mapError(status, rawText, cause) -> AppError
  /** 从上游最终载荷提取 Usage（无则返回 null，由核心做估算） */
  extractUsage(payload) -> Usage|null
}

// 注册表 src/adapters/registry.js
getAdapter(provider) -> BaseModelAdapter   // 按 provider id 取实例；未知抛 AppError('badreq')
listAdapters() -> [provider]
```

`ModelCapabilities`（字段固定，路由/上下文必读，**禁止硬编码到业务层**）：
```js
{
  supportsStreaming, supportsTools, supportsVision, supportsSystemPrompt,
  supportsThinking, supportsStructuredOutput,
  contextWindow, maxOutputTokens,
  imageInputFormats: ['base64'|'url'|'multipart'],
  toolCallFormat: 'openai'|'anthropic'|'gemini',
  inputModalities:['text','image'], outputModalities:['text'],
}
```

### 2.1 各供应商协议要点（不得遗漏，即使 OpenAI 兼容也不得假设全功能一致）

| provider | 鉴权 | 端点（相对 base） | system | 流式 | 思考链 |
|---|---|---|---|---|---|
| openai | `Authorization: Bearer` | `/chat/completions` | messages role=system | SSE `data:`，`[DONE]` | delta.`reasoning_content`（o系 `reasoning_tokens`） |
| anthropic | `x-api-key` + `anthropic-version: 2023-06-01` | `/v1/messages` | **顶层 `system`，禁止塞进 messages** | 多事件 message_start / content_block_delta / message_delta / message_stop | `thinking_delta` |
| gemini | `?key=`（或 `x-goog-api-key`） | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | `systemInstruction.parts` | SSE data JSON，候选 content.parts | part.`thought`/thoughtSignature |
| deepseek | Bearer | `/chat/completions`（OpenAI 兼容） | OpenAI 方式 | OpenAI | delta.`reasoning_content`（reasoner） |
| qwen | Bearer | DashScope compatible-mode `/chat/completions` | OpenAI | OpenAI | `reasoning_content` |
| zhipu | Bearer | `/chat/completions`（paas/v4） | OpenAI | OpenAI | reasoning 字段 |
| doubao | Bearer | Ark `/api/v3/chat/completions` | OpenAI | OpenAI | 部分模型 reasoning |
| kimi | Bearer | `/chat/completions`（Moonshot） | OpenAI | OpenAI | 无 |
| custom | Bearer（用户给） | 用户 base + `/chat/completions` | OpenAI | OpenAI | 按 capabilities 配置 |

**[HARD]**
- Anthropic system 必须顶层；工具是 `tool_use`/`tool_result` content block。
- Gemini 工具是 `functionCall`/`functionResponse` part，不是 OpenAI `tool_calls` 数组，必须结构转换。
- 思考链一律产出 `reasoningDelta`，独立 `reasoning` part，禁止拼正文。
- OpenAI 兼容各家的**错误码、限流响应、用量字段名**仍需在各自适配器单独解析（如 `usage.prompt_tokens_details.cached_tokens`）；流式请求体带 `stream_options:{include_usage:true}`，若该供应商不支持应能容忍 400 并在测试中体现。
- 上游未回传 usage 时由核心按文本保守估算（`usageSource:'estimated'`）。

---

## 3. 传输层（第三层）`src/transport/`

### 3.1 `httpClient.js` 导出
```js
safeFetch(rawUrl, options) -> Promise<{ status, headers, body /*Readable stream*/, raw }>
// options: { method?, headers{}, body?, signal?, timeoutMs=120000, maxRedirects=3, allowInsecure?, requestId?, ssrfProfile? }
```
要求：
1. **协议**：仅 `https:`；`http:` 仅当 `ALLOW_INSECURE_LOCAL_MODE=true` 且命中本地 profile（见 SSRF）。
2. **统一超时**：默认 120s（可按模型覆盖），与外部 `signal` 合并（任一触发即中止）。
3. **取消**：透传 `AbortSignal` 到连接。
4. **重试**：仅对 `429 / 5xx / 网络错误`，指数退避，最多 2 次，且仅当请求为幂等只读文本生成；重试复用 `requestId` 并附带重试计数。
5. **追踪**：自动注入 `X-Request-ID`（无则生成 UUID）。
6. **重定向**：undici 设 `maxRedirections:0`，手动处理 3xx，最多 3 次，**每次 Location 重新走完整 SSRF 校验**。
7. **禁止用户自定义任意头**：只允许适配器白名单内的鉴权/内容类型/版本头，剥除 `host`、`x-forwarded-*` 等。
8. 使用 `undici` 的 `Agent`，`connect.lookup` 必须替换为 **guardedLookup**：在真正建立 TCP 连接的时刻做 DNS 解析并校验 IP（undici 会连接 lookup 返回的地址，同时保留 TLS servername），以此防 DNS 重绑定。

### 3.2 `sse.js` 导出
```js
pumpSSE(stream, { onLine, onEvent?, signal }) -> Promise<void>
// 按 \n 拆行（去 \r），空行分隔事件；识别 'event:' 与 'data:'；连接中断/abort 要明确抛错（含 code）
```
需覆盖：正常 chunk、错误事件中途出现、`[DONE]` 提前、连接中断、空 chunk。

### 3.3 SSRF 守卫 `src/core/security/ssrf.js`
```js
assertUrlAllowed(rawUrl, { allowInsecure, profile }) -> { url, host }
createGuardedLookup({ allowInsecure, profile }) -> function lookup(hostname, options, cb)
isBlockedIp(ip) -> boolean
```
- 阻断：回环 `127.0.0.0/8`、`::1`；私有 `10/8`、`172.16/12`、`192.168/16`、`fc00::/7`；链路本地 `169.254/16`、`fe80::/10`。
- 显式阻断云元数据：`169.254.169.254`、阿里云 `100.100.100.200`、腾讯云 `169.254.0.23`（及华为 `169.254.169.254` 同段）。
- DNS 解析后逐个 IP 校验，仅返回安全地址；全部不安全则拒绝。
- 连通性测试（credentials test）：独立 5s 超时，不带任何用户 Cookie / 内部凭据。
- 本地模式不是「关闭校验」：`LOCAL_MODEL_MODE` 开启时仅允许 `http://127.0.0.1:11434` 与显式登记的局域网地址，且不加载云供应商密钥表。

---

## 4. 安全：加密与脱敏 `src/core/security/`

### 4.1 `crypto.js`（AES-256-GCM）
```js
encryptSecret(plaintext, { keyId? }) -> string
// 格式固定：v1:<keyId>:<base64(nonce 12B)>:<base64(ciphertext)>:<base64(tag 16B)>
decryptSecret(payload) -> string   // 按 payload 内 keyId 选 key；支持多 key（轮换）
maskSecret(secret) -> string       // 前4 + '***' + 后4；过短则全打码
rotateReEncrypt?(...)              // 提供批量重加密辅助（脚本可调用）
```
- 主密钥来自环境变量：当前密钥 `MASTER_ENCRYPTION_KEY`（base64，32B），其 id 由 `ENCRYPTION_KEY_ID` 指定。
- 轮换：`ENCRYPTION_KEYS={"oldId":"base64key",...}` 提供旧密钥，仅用于解密；新写入一律用当前 key。旧密钥禁止出现在 DB / 日志 / 仓库。
- 每次加密随机 nonce。

### 4.2 日志脱敏 `redact.js`
- 中间件记录请求时，对 `authorization`、`x-api-key`、`proxy-authorization`、cookie 中 token、以及 body/query 中名为 `api_key/key/secret/password/token` 的字段打码（如 `sk-***masked***`）。
- 提供 `redactObject(obj)` 递归脱敏，供任何日志复用。

### 4.3 限流 `rateLimit.js`（进程内，无 Redis）
- 滑动窗口 + 令牌桶的内存实现：`createRateLimiter({ windowMs, max })`，中间件工厂 `rateLimit({ keyBy, windowMs, max })`。
- 预置：登录/注册 `5 次 / 15min / IP+email`（失败 5 次锁 15min）；API `按用户` 每分钟请求数；并发生成上限默认 3（聊天核心另核 DB running 数）。
- 文档注明：内存限流为**单实例**有效；多实例需 Render Redis 或切到 DB 实现（给出扩展点，不本期实现）。

---

## 5. 数据库 `src/db/`

- `pool.js`：基于 `pg.Pool`，从 `DATABASE_URL` 创建；导出 `query`、`withTransaction`、`getPool`、`endPool`。生产开启 SSL（`ssl:{rejectUnauthorized:false}`，Render 要求），本地可关。
- `migrate.js`：自建轻量迁移 runner。表 `schema_migrations(version PK, applied_at)`；按 `src/db/migrations/*.sql` 文件名顺序执行，每个文件在事务内，**可重复执行**（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`）。`npm run migrate` 可反复跑。
- `seed.js`：幂等 upsert 8 家供应商 + 24 模型 + 能力 + 当前价格版本；由迁移末或 `npm run seed` 触发，重复执行不产生重复行。

### 5.1 必建表（micro 整数；软删除 archived_at/deleted_at）
`users, user_sessions, conversations, messages, message_parts, message_branches,
generation_jobs, generation_events, providers, provider_credentials, models,
model_capabilities, attachments, tool_calls, usage_records, pricing_versions,
prompt_templates, user_settings, idempotency_keys, audit_logs`

主键统一 `TEXT`（应用生成带前缀 id，如 `usr_/ses_/cvs_/msg_/prt_/job_/evt_/prv_/crd_/mdl_/cap_/att_/tc_/use_/pv_/idem_/aud_`），时间戳 `TIMESTAMPTZ NOT NULL DEFAULT now()`。

关键字段：
- users: email UNIQUE, password_hash, tier DEFAULT 'free', failed_login_count, locked_until, disabled_at
- user_sessions: user_id, refresh_token_hash, expires_at, revoked_at, ip, user_agent, created_at
- conversations: user_id, title, model_id, current_branch_id, archived_at
- messages: conversation_id, role, branch_id, parent_message_id, status, job_id, deleted_at
- message_parts: message_id, type, seq, content_json JSONB
- message_branches: conversation_id, parent_message_id, branch_index
- generation_jobs: message_id, user_id, provider, model, status, request_id, idempotency_key,
  cancel_requested_at, cancel_acknowledged_at, upstream_closed_at, error_code, error_message,
  usage_id, started_at, finished_at
- generation_events: job_id, seq, event_type, payload_json JSONB（断线补流）
- providers: slug UNIQUE, name, default_base_url, kind('openai'|'anthropic'|'gemini'), enabled, circuit_open
- provider_credentials: user_id, provider_id, encrypted_credentials TEXT, masked_hint, base_url, created_at, rotated_at；UNIQUE(user_id, provider_id)
- models: provider_id, slug（供应商原生模型名）UNIQUE, display_name, is_default
- model_capabilities: model_id UNIQUE, capabilities JSONB
- attachments: user_id, message_id, storage_key, mime, size_bytes, parse_status, parsed_text_ref
- tool_calls: message_id, tool_call_id, tool_name, args_json, result_json, status, duration_ms
- usage_records: user_id, job_id, provider, model, prompt_tokens, completion_tokens,
  cost_micro BIGINT, currency DEFAULT 'CNY', usage_source, priced_at, idempotency_key
- pricing_versions: provider, model, effective_from, effective_to NULLABLE,
  input_price_micro_per_mtok BIGINT, output_price_micro_per_mtok BIGINT, currency
- user_settings: user_id UNIQUE, routing_mode, default_model_id, budget_daily_micro, max_output_tokens
- idempotency_keys: key UUID, user_id, scope, job_id, status('processing'|'done'|'error'),
  result_ref, created_at, expires_at；UNIQUE(key)
- audit_logs: user_id, action, ip, meta_json JSONB

索引：外键列、generation_jobs(user_id,status)、usage_records(user_id,priced_at)、idempotency_keys(expires_at)。

---

## 6. 模型目录（种子权威数据，8 家 24 模型）

> 价格为近似人民币（元/百万 token，USD 已按 7.1 折算）；flags: vision/tools/think/struct。
> 入库时价格转 micro/Mtok：`priceMicro = round(元 * 1e6)`。能力按 flags + 下表 ctx/out 生成 capabilities JSONB。

| id | provider | 原生模型 slug | 名称 | ctx | out | flags | in元 | out元 |
|---|---|---|---|---|---|---|---|---|
| gpt-4o | openai | gpt-4o | GPT-4o | 128000 | 16384 | vision,tools,struct | 17.8 | 71 |
| gpt-4o-mini | openai | gpt-4o-mini | GPT-4o mini | 128000 | 16384 | vision,tools,struct | 1.07 | 4.26 |
| gpt-4.1 | openai | gpt-4.1 | GPT-4.1 | 1047576 | 32768 | tools,struct | 14.2 | 56.8 |
| o3-mini | openai | o3-mini | o3-mini | 200000 | 65536 | think,tools,struct | 7.8 | 31.2 |
| claude-sonnet | anthropic | claude-sonnet-4-5-20250929 | Claude Sonnet 4.5 | 200000 | 8192 | vision,tools | 21.3 | 106.5 |
| claude-haiku | anthropic | claude-3-5-haiku-latest | Claude Haiku 3.5 | 200000 | 8192 | vision,tools | 5.7 | 28.4 |
| claude-opus | anthropic | claude-opus-4-20250514 | Claude Opus 4 | 200000 | 32000 | vision,tools | 106.5 | 532.5 |
| gemini-flash | gemini | gemini-2.0-flash | Gemini 2.0 Flash | 1048576 | 8192 | vision,tools,struct | 0.71 | 2.84 |
| gemini-pro | gemini | gemini-2.5-pro | Gemini 2.5 Pro | 1048576 | 65536 | vision,tools,think,struct | 8.5 | 35.5 |
| gemini-flash-15 | gemini | gemini-1.5-flash | Gemini 1.5 Flash | 1048576 | 8192 | vision,tools,struct | 0.5 | 2.1 |
| deepseek-chat | deepseek | deepseek-chat | DeepSeek Chat V3 | 65536 | 8192 | tools,struct | 2 | 8 |
| deepseek-r1 | deepseek | deepseek-reasoner | DeepSeek R1 推理 | 65536 | 8192 | think,tools | 3 | 16 |
| qwen-plus | qwen | qwen-plus | Qwen Plus | 131072 | 8192 | tools,struct | 0.8 | 2 |
| qwen-turbo | qwen | qwen-turbo | Qwen Turbo | 131072 | 8192 | tools,struct | 0.3 | 0.6 |
| qwen-max | qwen | qwen-max | Qwen Max | 32768 | 8192 | tools,struct | 20 | 60 |
| qwen-vl | qwen | qwen-vl-plus | Qwen VL 视觉 | 32768 | 8192 | vision,tools | 8 | 8 |
| glm-plus | zhipu | glm-4-plus | GLM-4 Plus | 128000 | 4096 | tools,struct | 50 | 50 |
| glm-flash | zhipu | glm-4-flash | GLM-4 Flash | 128000 | 4096 | tools,struct | 0.1 | 0.1 |
| glm4v | zhipu | glm-4v-plus | GLM-4V 视觉 | 8192 | 4096 | vision | 50 | 50 |
| doubao-pro | doubao | doubao-pro-32k | 豆包 Pro 32K | 32768 | 4096 | tools,struct | 5 | 15 |
| doubao-lite | doubao | doubao-lite-32k | 豆包 Lite 32K | 32768 | 4096 | tools,struct | 0.3 | 0.6 |
| kimi-8k | kimi | moonshot-v1-8k | Kimi 8K | 8192 | 4096 | （无） | 12 | 12 |
| kimi-32k | kimi | moonshot-v1-32k | Kimi 32K | 32768 | 4096 | （无） | 24 | 24 |
| kimi-128k | kimi | moonshot-v1-128k | Kimi 128K | 131072 | 4096 | （无） | 60 | 60 |

默认 base url（providers.default_base_url）：
- openai `https://api.openai.com/v1`；anthropic `https://api.anthropic.com`；gemini `https://generativelanguage.googleapis.com`
- deepseek `https://api.deepseek.com/v1`；qwen `https://dashscope.aliyuncs.com/compatible-mode/v1`
- zhipu `https://open.bigmodel.cn/api/paas/v4`；doubao `https://ark.cn-beijing.volces.com/api/v3`；kimi `https://api.moonshot.cn/v1`

能力映射规则：`supportsStreaming=true`（全部）；`supportsSystemPrompt=true`（全部，gemini 走 systemInstruction）；
vision/tools/think/struct 按 flags；`imageInputFormats`：openai 系 `['url']`（但 dataURL 亦可，前端传 dataURL 时 openai 接受 url 字段塞 dataURL）、anthropic `['base64']`、gemini `['base64']`；
`toolCallFormat`：openai 系 `'openai'`、anthropic `'anthropic'`、gemini `'gemini'`。

---

## 7. 统一错误码与 HTTP 状态

`auth(401,不可重试) / forbidden(403) / notfound(404) / rate(429,可重试) / badreq(400,不可重试) /
nokey(400) / upstream(502,可重试) / network(502,可重试) / timeout(504,可重试) /
cancel(499 语义,不可重试) / conflict(409) / budget(402) / internal(500)`。
安全异常（SSRF 拦截）使用 `badreq`，message 明确「目标地址不被允许」。

---

## 8. REST API 契约（前缀 `/api`）

认证方式：`Authorization: Bearer <accessToken>`；refresh token 存 httpOnly cookie `au_refresh`。
除注册/登录/健康检查/静态页外，均需 access 中间件。统一响应 JSON；错误体 `{ error:{ code, message } }`。

### 8.1 认证 `/api/auth`
- `POST /register` {email,password} -> {user:{id,email}, accessToken}；set-refresh-cookie
- `POST /login` {email,password} -> 同上；失败计数/锁定；审计
- `POST /refresh` -> {accessToken}（凭 cookie；无效/已撤销 401）
- `POST /logout` -> 撤销当前 session
- `GET /me` -> {user}
- `GET /sessions` -> [{id,ip,userAgent,createdAt,current}]
- `POST /sessions/:id/revoke` -> 204；改密后全量撤销
（密码 bcryptjs，cost≥10；access 15min，refresh 7d）

### 8.2 目录 `/api/catalog`
- `GET /` -> { providers:[{slug,name,kind,enabled}], models:[{id,provider,slug,displayName,isDefault,capabilities,pricing:{inputMicroPerMtok,outputMicroPerMtok,currency}}] }

### 8.3 凭证 `/api/credentials`
- `GET /` -> [{provider, baseUrl, maskedHint, configured}]
- `PUT /:provider` {baseUrl?, apiKey} -> {provider, maskedHint}（不回显完整 key；重输直接覆盖，不回填旧值）；baseUrl 仅做格式/SSRF 静态校验
- `DELETE /:provider` -> 204（立即作废，清除内存副本）
- `POST /:provider/test` -> {ok, latencyMs?} 或 {ok:false, code,message}（5s 超时，最小请求，不带内部凭据）

### 8.4 对话 `/api/conversations`
- `GET /` -> [{id,title,modelId,updatedAt,lastSnippet}]
- `POST /` {title?, modelId?} -> {conversation}
- `GET /:id` -> {conversation, messages:[{id,role,status,parts,usage,createdAt}]}
- `PATCH /:id` {title?, modelId?}（modelId 仅在非生成中可改）
- `DELETE /:id` -> 设置 archived_at
- `POST /:id/messages` headers `Idempotency-Key: <uuid>` body {text, attachments?} -> **SSE 流**（见 §9）
- `POST /:id/regenerate` -> SSE 流（新建分支/新 job，不覆盖旧消息）

### 8.5 生成任务 `/api/chat/jobs`
- `POST /:id/cancel` -> {status, cancelRequestedAt}（标记并 abort；不保证上游即刻停止）
- `GET /:id` -> {job:{status, cancelRequestedAt, cancelAcknowledgedAt, upstreamClosedAt, errorCode, usage}}
- `GET /:id/events?afterSeq=` -> SSE/JSON 重放 generation_events（断线补流）

### 8.6 用量 `/api/usage`
- `GET /summary` -> {today:{costMicro,tokens,calls}, month:{costMicro}, byModel:[{modelId,costMicro}], byProvider:[{provider,costMicro}]}
- `GET /records?from=&to=` -> [usage_records]

### 8.7 设置 `/api/settings`
- `GET /` -> user_settings；`PATCH /` {routingMode?, defaultModelId?, budgetDailyMicro?, maxOutputTokens?}

### 8.8 管理员 `/api/admin`（tier='admin'）
- `POST /providers/:slug/disable`|`/enable`（熔断/恢复）；`POST /users/:id/disable`|`/enable`；`POST /readonly` {on}（全局只读，内存标志 + 启动持久化）
- 异常告警（5xx 率>30%/1min 或费用突增 5 倍）记录审计并自动熔断该 provider（核心实现，测试覆盖判定函数）。

### 8.9 健康检查（无需认证）
- `GET /healthz` -> 200 {status:'ok'}（进程存活）
- `GET /readyz` -> 检查 DB 连通，成功 200 {db:'ok'}，失败 503

---

## 9. 聊天 SSE 事件格式（`POST /conversations/:id/messages`）

响应 `Content-Type: text/event-stream; charset=utf-8`，`Cache-Control: no-cache`，`X-Accel-Buffering: no`。
事件（均 `event: <type>\ndata: <json>\n\n`）：
1. `event: start`：`{jobId, userMessageId, assistantMessageId}`
2. `event: delta`：`{kind:'text'|'reasoning', text}`（增量，前端拼接）
3. `event: status`：`{status}`（running 等）
4. `event: usage`：`{promptTokens, completionTokens, usageSource}`
5. `event: done`：`{status:'completed', costMicro, promptTokens, completionTokens}`
6. `event: error`：`{code, message, retryable}`
7. `event: cancelled`：`{acknowledged:bool, upstreamClosed:bool, costMicro, promptTokens, completionTokens}`（即使取消，上游已产 token 仍计费回传）

每个事件同时按 seq 落 `generation_events`，供 `jobs/:id/events` 重放。

---

## 10. 生成任务状态机 `src/core/chat/stateMachine.js`

状态：`queued / running / completed / failed / cancelled / interrupted`。
合法转换（导出 `TRANSITIONS` 与 `assertTransition(from,to)`，非法抛 AppError('conflict')）：
```
queued->running
running->completed | failed | cancelled | interrupted
interrupted->completed | failed
failed->queued  (仅自动重试次数<上限且错误可重试)
```
- 取消须记录 `cancel_requested_at / cancel_acknowledged_at / upstream_closed_at`，并区分：本地是否已确认、上游连接是否真正关闭、最终用量是否拿到。
- 「点停止」≠「上游已停算」：即使本地 cancelled，上游实产 token 必须记账。
- 前端状态、DB job.status、上游状态通过同一 SSE 事件流同步，禁止前端乐观完成。
- 生成中再发消息：**排队**（同会话不允许两条流并发写）；代码必须明确实现（新消息在该会话有 running/queued job 时返回 409/排队提示）。
- 切换模型不影响旧任务，旧任务跑完或显式取消，禁止隐式丢弃。

---

## 11. 上下文管理器 `src/core/context/contextManager.js`

`buildMessages({ conversation, newUserParts, model, capabilities }) -> { messages: [ChatMessage], estimatedTokens }`
1. 读 capabilities.contextWindow / maxOutputTokens；`reserveOutput = round(maxOutputTokens*1.1)`。
2. 系统安全指令 token 固定预算、**永不裁剪**，置于最前（系统指令段显式排除在裁剪逻辑外）。
3. `available = ctx - systemTokens - reserveOutput - currentUserTokens - attachmentsTokens`。
4. 从最近历史向前累加直到 available 用尽；更早历史进入摘要候选。
5. **tool_call 与对应 tool_result 必须成对保留**，禁止拆开。
6. token 估算（无官方 tokenizer 时）：CJK 字符 ≈ 1.3 token（保守可取 1.5），其余 ≈ 1 token/4 字符；图片按 ~1200 token/张。导出 `estimateTokens(text)`。
7. 超长策略（可配置，默认截断）：保留最近 N 轮；或摘要压缩（小模型把更早历史压成 `[早期对话摘要]…`）。
8. 捕获上游上下文长度错误（badreq 且 message 命中 context/length/too many/token），**自动压缩后重试一次**（仅一次）。
提供 `compressedMessages(...)`（保留最近 4 条 + 系统说明）。

---

## 12. 自动路由 `src/core/routing/router.js`

三模式存 user_settings.routing_mode：`manual`（不得擅切）/ `recommend`（推荐、用户确认）/ `auto`（自动）。
`classifyTask(text, hasImages) -> 'vision'|'coding'|'reasoning'|'chat'`（规则同前端：图片→vision；代码/报错/算法等→coding；为什么/分析/推理/对比/数学等→reasoning；否则 chat）。
`fitScore(capabilities, task)`：vision 支持 +60 否则 -999；coding：struct +18、tools +14；reasoning：think +40 否则 +8；chat +6。
`autoSelect({ task, contextNeed, credentials:Set, models[], dailyBudget, maxOutTokens })`：
1. 过滤：能力满足模态（vision 必须 supportsVision）、该 provider 已配置凭证（或 demo 模式）、provider 未熔断/启用、contextWindow≥contextNeed。
2. 每任务预算 = `dailyBudget*0.2`（micro）；预估 `costMicro = floor((contextNeed*inPrice + maxOut*outPrice)/1e6)`，超预算则淘汰。
3. 打分：`score = fit - (inPrice+outPrice)*0.25 - (ctx>500000?2:0)`（价格用 micro/Mtok，注意量纲一致，权重可在实现中标注），取最高。
4. 返回 `{ model, reason }`，记录 routing_decision。
**[HARD] 自动切换安全**：仅当请求尚无不可逆副作用（纯只读文本生成）才自动重试/切换；已触发工具执行则禁止切换，上报用户。第二次调用费用照计，UI 标注「自动切换自 X→Y」。

---

## 13. 计费 `src/core/billing/`

- `pricing.js`：`getPricing(provider, model, at=now) -> {inputMicroPerMtok, outputMicroPerMtok, currency}`，按 priced_at 落在 pricing_versions 区间取价，**禁止用现价回溯历史**。
- `usage.js`：
  - `computeCostMicro({provider, model, promptTokens, completionTokens, at}) -> {costMicro, inputMicro, outputMicro}`（整数公式 §0）。
  - 上游未回传用量：按文本保守估算（prompt=estimateTokens(拼接输入)，completion=estimateTokens(已产出文本)），usageSource='estimated'。
  - 部分失败/取消：按实际已收到 completion tokens 计费，未生成不计。
  - 重复请求：幂等键在源头消除；`recordUsage` 前校验同 idempotency_key 已存在则不重复记账。
- 预算门（调用前）：每日费用上限、每分钟/每日次数、单任务预算、并发上限；超限抛 `budget`。

---

## 14. 服务端 demo 适配器 `src/core/chat/demoAdapter.js`
把前端 demo 逻辑搬到服务端：无凭证时按模型能力产出模拟 reasoning + 结构化文本流（逐块 yield，可被 cancel），并返回估算 usage。使「无真实 Key」也能端到端演示 SSE，且不扣费（不写 usage_records 或 costMicro=0，需在测试与 README 注明）。

---

## 15. Express 装配与静态托管
- `src/app.js`：创建 express，挂 helmet（按需调整 CSP 以允许内联/同源）、cors（开发白名单，生产同源）、cookie-parser、express.json({limit:'2mb'})、请求日志（脱敏）、`/api/*` 各路由、静态托管 `src/public`（`/` 返回 index.html）、统一 404 与错误处理中间件（错误转 §7 JSON，不泄露堆栈）。
- `src/server.js`：load config（fail-fast）→ run migrate + seed（可用 env `RUN_SEED=true`）→ listen `PORT`（Render 注入）→ `/healthz`、`/readyz`；SIGTERM/SIGINT 优雅关停（停接新请求、等待在跑 job 落库、endPool 后退出）。

---

## 16. 模块/文件归属（避免并行写冲突）

| 单元 | 拥有路径（只允许它创建/修改） |
|---|---|
| 基础 F | src/config.js, src/db/*, src/transport/*, src/adapters/base.js, src/adapters/registry.js, src/core/security/*, src/middleware/*（通用）, test/crypto|ssrf|transport.test.js |
| 适配器 A | src/adapters/anthropic.js, gemini.js, samples/anthropic-*, samples/gemini-*, test/adapters/anthropic|gemini.test.js |
| 适配器 B | src/adapters/deepseek.js, kimi.js, samples/*, test/adapters/deepseek|kimi.test.js |
| 适配器 C | src/adapters/qwen.js, zhipu.js, samples/*, test/adapters/qwen|zhipu.test.js |
| 适配器 D | src/adapters/doubao.js, custom_openai_compatible.js, samples/*, test/adapters/doubao|custom.test.js |
| 认证/凭证 | src/core/auth/*, src/core/credentials/*, src/routes/auth.routes.js, credentials.routes.js, test/integration/auth.test.js |
| 计费/路由 | src/core/billing/*, src/core/routing/*, test/billing.test.js, test/router.test.js |
| 聊天核心 | src/core/chat/*, src/core/context/*, src/routes/conversations|chat|usage|settings|catalog|admin.routes.js, src/app.js, src/server.js, test/context|statemachine.test.js, test/integration/chat*.test.js |
| 前端 | src/public/index.html（仅此文件） |
| 部署 | Dockerfile, docker-compose.yml, render.yaml, .env.example, .dockerignore, docs/DEPLOY*.md |
| README | README.md, docs/ARCHITECTURE.md, docs/API.md |

所有单元**只读**别人的文件，不得修改；集成问题上报 Organizer。

---

## 17. 测试清单（`npm test` 全绿）
- 适配器（每家）：请求转换、流解析（正常/错误中途/[DONE]提前/中断/空chunk）、错误映射、能力声明、用量提取。
- 单测：crypto（加解密/错误 key/格式）、ssrf（内网/元数据/重定向/自定义头/DNS）、context（预算/裁剪/成对保留/系统保留）、router（过滤/打分/预算门/副作用判断）、billing（整数/调价/部分失败/重复）、stateMachine（合法非法/interrupted 恢复）。
- 集成（本地 mock 上游，不真实扣费）：注册→登录→建会话→SSE 流式（demo 或 mock）→取消→历史落库→usage；幂等重复 key 不产生第二次调用；readyz DB。
