# API 参考（AI Universe Backend）

- Base URL：`/api`（健康检查与前端页面在根路径）
- 认证：除注册/登录/刷新/健康检查外，均需请求头 `Authorization: Bearer <accessToken>`
- 写请求建议携带 `Idempotency-Key`（聊天发消息为**必填**）
- 内容类型：`application/json`（流式接口返回 `text/event-stream`）
- 刷新令牌经 httpOnly cookie `au_refresh` 自动携带，无需手动管理

---

## 0. 通用约定

### 错误响应

```json
{ "error": { "code": "badreq", "message": "模型不存在: xxx" } }
```

| code | 典型 HTTP | 含义 | 是否可重试 |
|---|---|---|---|
| `auth` | 401 | 未认证/密钥无效 | 否 |
| `forbidden` | 403 | 无权限/账号停用 | 否 |
| `notfound` | 404 | 资源不存在 | 否 |
| `badreq` | 400 | 请求参数错误 | 否 |
| `conflict` | 409 | 状态冲突（如非法状态转换、生成中切模型） | 视情况 |
| `rate` | 429 | 触发限流/上游限流 | 是 |
| `budget` | 402/403 | 超出预算/额度 | 否 |
| `upstream` | 502/503/504 | 上游供应商错误 | 是 |
| `cancel` | 499/400 | 请求被取消 | 否 |
| `internal` | 500 | 服务器内部错误（不泄堆栈） | 否 |

### 金额与用量

- 金额一律整数 **micro**：1 元 = 1,000,000；
- token 为整数；`usageSource` 为 `upstream`（上游回传）或 `estimated`（保守估算）。

---

## 1. 认证 `/api/auth`

### POST `/register`

```json
// 请求
{ "email": "you@example.com", "password": "Passw0rd!2026" }
// 201 响应（同时 Set-Cookie: au_refresh=...; HttpOnly）
{
  "user": { "id": "usr_xxx", "email": "you@example.com", "tier": "free" },
  "accessToken": "eyJ..."
}
```

### POST `/login`

请求体同 register；响应 `200`，结构同 register。连续失败 5 次锁定 15 分钟（429）。

### POST `/refresh`

凭 httpOnly cookie 换新访问令牌：

```json
{ "accessToken": "eyJ...", "user": { "id": "usr_xxx", "email": "...", "tier": "free" } }
```

### POST `/logout`

撤销当前刷新会话、清除 cookie。`204`。

### GET `/me`

```json
{ "user": { "id": "usr_xxx", "email": "you@example.com", "tier": "free" } }
```

### GET `/sessions`

```json
{ "sessions": [ { "id": "ses_xxx", "ip": "...", "userAgent": "...", "current": true, "createdAt": "...", "lastUsedAt": "..." } ] }
```

### POST `/sessions/:id/revoke`

撤销指定会话。`204`。

---

## 2. 模型目录 `/api/catalog`

### GET `/`

返回供应商与模型目录（含能力、价格、是否默认）：

```json
{
  "providers": [ { "slug": "openai", "name": "OpenAI", "kind": "commercial", "enabled": true } ],
  "models": [
    {
      "id": "mdl_gpt-4o-mini",          // 全局统一模型 id（会话/选择都用它）
      "provider": "openai",
      "slug": "gpt-4o-mini",            // 供应商原生模型名
      "displayName": "GPT-4o mini",
      "isDefault": true,
      "capabilities": {
        "supportsStreaming": true, "supportsTools": true, "supportsVision": true,
        "supportsThinking": false, "supportsStructuredOutput": true,
        "contextWindow": 128000, "maxOutputTokens": 16384,
        "inputModalities": ["text", "image"], "outputModalities": ["text"],
        "toolCallFormat": "openai"
      },
      "pricing": { "inputMicroPerMtok": 1070000, "outputMicroPerMtok": 4260000 }
    }
  ]
}
```

共 8 供应商、24 模型。

---

## 3. 凭证 `/api/credentials`

> 任何响应都**不回显完整 Key**，只给掩码与配置状态。

### GET `/`

```json
{
  "credentials": [
    { "provider": "openai", "configured": true, "maskedHint": "sk-l***cdef", "baseUrl": null, "updatedAt": "..." },
    { "provider": "anthropic", "configured": false, "maskedHint": null }
  ]
}
```

### PUT `/:provider`

```json
// 请求（baseUrl 可选，仅 OpenAI 兼容供应商可自定义；会经 SSRF 校验）
{ "apiKey": "sk-xxxx", "baseUrl": "https://your-gateway.example.com/v1" }
// 响应
{ "provider": "openai", "configured": true, "maskedHint": "sk-x***xxxx" }
```

### DELETE `/:provider`

删除该供应商凭证。`204`。

### POST `/:provider/test`

5 秒超时的最小鉴权探测（不扣费）：

```json
{ "provider": "openai", "ok": true }
// 未配置 Key：{ "provider": "openai", "ok": false, "code": "nokey" }
```

---

## 4. 对话 `/api/conversations`

### GET `/`

返回裸数组：

```json
[ { "id": "cvs_xxx", "title": "新对话", "modelId": "mdl_gpt-4o-mini", "updatedAt": "...", "lastSnippet": "你好" } ]
```

### POST `/`

```json
// 请求（title/modelId 均可省略；省略 modelId 时后端固化默认模型）
{ "title": "新对话", "modelId": "mdl_gpt-4o-mini" }
// 201
{ "id": "cvs_xxx", "title": "新对话", "modelId": "mdl_gpt-4o-mini", "createdAt": "...", "updatedAt": "..." }
```

### GET `/:id`

```json
{
  "conversation": { "id": "cvs_xxx", "title": "...", "modelId": "mdl_gpt-4o-mini", "createdAt": "...", "updatedAt": "..." },
  "messages": [
    { "id": "msg_1", "role": "user", "status": "completed", "jobId": null, "createdAt": "...",
      "parts": [ { "type": "text", "text": "你好" } ], "usage": null },
    { "id": "msg_2", "role": "assistant", "status": "completed", "jobId": "job_xxx", "createdAt": "...",
      "parts": [ { "type": "text", "text": "..." } ],
      "usage": { "promptTokens": 12, "completionTokens": 90, "costMicro": 0, "usageSource": "estimated" } }
  ]
}
```

多部分示例：`parts` 可含 `{type:'reasoning',text}`、`{type:'tool_call',id,name,args}`、`{type:'tool_result',id,content}`、`{type:'image',...}`、`{type:'refusal',text}`。

### PATCH `/:id`

```json
{ "title": "新标题", "modelId": "mdl_claude-haiku" }
```

生成中切换模型返回 `409`。响应为更新后的 `{conversation, messages}`。

### DELETE `/:id`

软删除（归档）。`204`。

---

## 5. 发消息与流式输出

### POST `/:id/messages`（SSE）

- 必填头：`Idempotency-Key: <uuid>`；
- 请求体：

```json
{ "text": "你好，请用三句话介绍你自己", "attachments": [] }
```

- 成功返回 `200 text/event-stream`；前置校验失败返回 JSON 错误。
- 同 `Idempotency-Key` 重复提交：重放已有事件，不新建任务。

#### SSE 事件（实时）

| event | data 关键字段 | 说明 |
|---|---|---|
| `start` | `{jobId, messageId, model}` | 任务开始 |
| `status` | `{status}` | 状态变化（queued/running…） |
| `delta` | `{kind:'text'\|'reasoning', text}` | 增量文本 / 思考链 |
| `usage` | `{promptTokens, completionTokens, costMicro, usageSource}` | 用量与费用 |
| `done` | `{messageId, finishReason}` | 正常完成 |
| `error` | `{code, message, retryable}` | 生成失败 |
| `cancelled` | `{messageId, billedTokens, costMicro}` | 被取消（含是否计费） |

`delta` 中工具相关以多部分形式呈现（`tool_call/tool_result`）。无凭证时由服务端演示引擎产出，`costMicro=0`。

### POST `/:id/regenerate`（SSE）

对最后一条 assistant 重新生成（事件序列同上），不重复创建用户消息。

---

## 6. 生成任务 `/api/chat`

### POST `/jobs/:id/cancel`

```json
{ "status": "cancelled", "cancelRequestedAt": "...", "alreadyEnded": false }
```

### GET `/jobs/:id`

```json
{ "job": { "id": "job_xxx", "status": "running", "messageId": "msg_x", "model": "..." }, "usage": null }
```

### GET `/jobs/:id/events?afterSeq=<n>`（SSE，断线补流）

重放/续接该任务从 `afterSeq` 之后的事件（事件名同上）。打开会话时若发现仍在 running/queued 的消息，前端用它恢复流。

---

## 7. 用量 `/api/usage`

### GET `/summary`

```json
{
  "today": { "costMicro": 0, "tokens": 0, "calls": 0 },
  "month": { "costMicro": 0 },
  "byModel": [ { "modelId": "mdl_gpt-4o-mini", "costMicro": 0 } ],
  "byProvider": [ { "provider": "openai", "costMicro": 0 } ]
}
```

### GET `/records?from=&to=`

返回用量记录数组（时间为 ISO8601，可空）：

```json
[ { "id": "ur_xxx", "provider": "openai", "model": "gpt-4o-mini",
    "promptTokens": 10, "completionTokens": 80, "costMicro": 351,
    "usageSource": "upstream", "pricedAt": "..." } ]
```

---

## 8. 设置 `/api/settings`

### GET `/`

```json
{ "routingMode": "manual", "defaultModelId": null, "budgetDailyMicro": 10000000, "maxOutputTokens": 4096 }
```

### PATCH `/`

```json
{ "routingMode": "auto", "defaultModelId": "mdl_gpt-4o-mini", "budgetDailyMicro": 20000000, "maxOutputTokens": 8192 }
```

返回更新后的平铺设置对象。`routingMode` 取值 `manual / recommend / auto`。

---

## 9. 管理员 `/api/admin`（需管理员）

| 方法/路径 | 作用 |
|---|---|
| POST `/providers/:slug/disable` | 停用供应商 |
| POST `/providers/:slug/enable` | 启用供应商 |
| POST `/users/:id/disable` | 停用用户 |
| POST `/users/:id/enable` | 启用用户 |
| POST `/readonly` | 切换全局只读（紧急停用写操作） |
| GET `/readonly` | 查询只读状态 `{readonly}` |
| POST `/catalog/sync` | 跑一次模型目录发现（body `{probe?:bool}`）；非管理员一律 403 |
| POST `/catalog/probe` | 跑一次健康探测（消耗极少量 token，不向用户计费） |
| GET `/catalog/status` | 最近发现/探测、新发现、已停用、待补价清单 |
| PATCH `/models/:id` | 改生命周期/能力/上下文/价格；`lifecycle='active'` 即重新启用 |

管理员判定（不引入角色表）：命中 `ADMIN_EMAILS` 名单、或 `tier='admin'`、或未配置名单时的首个注册用户。

**`POST /catalog/sync`** 响应含 `discovery` 汇总（各供应商 queried/added/seen/markedDeprecated/skipped）与可选 `probe` 汇总。
**`PATCH /models/:id`**（字段均可选）：`lifecycle`、`deprecationReason`、`capabilities`（JSON 合并）、
`contextWindow`、`maxOutputTokens`、`capabilitiesVerified`、`displayName`、
`pricing`（`{inputMicroPerMtok, outputMicroPerMtok, currency}`，对当前价 upsert）。补价前 discovered 模型成本为 NULL。

### Cron `/api/cron`（公开但需签名，不走管理员鉴权）

| 方法/路径 | 说明 |
|---|---|
| POST `/catalog-sync` | 头 `X-Cron-Secret: <CRON_SECRET>`；未配置 `CRON_SECRET` 返回 **503**，签名错误 401。body `{probe?:bool}` |

该端点由 Render Cron Job（可选，见 `render.yaml`）定时调用，使用平台 Key 发现，不读取任何用户凭证。

---

## 10. 健康检查（根路径，无需认证）

| 路径 | 200 响应 | 失败 |
|---|---|---|
| GET `/healthz` | `{ "status": "ok" }` | — |
| GET `/readyz` | `{ "db": "ok" }` | 503 `{ "db": "unavailable" }` |

Render 以 `/healthz` 作为健康检查路径。

---

## 11. SSE 最小示例（curl）

```bash
# 登录拿 token
TOK=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | jq -r .accessToken)

# 建会话
CID=$(curl -s -X POST $BASE/api/conversations -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# 发消息并观察流
curl -N -X POST "$BASE/api/conversations/$CID/messages" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"text":"你好"}'
```
