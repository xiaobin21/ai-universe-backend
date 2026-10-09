# 动态模型目录 · 集成契约（冻结）

本文件冻结「自动发现 + 自动停用」功能的接口、字段与口径，后端发现单元与前端/catalog 单元均以此为准，不得各自漂移。接口最终对外形态另见 docs/API.md。

迁移：`src/db/migrations/003_dynamic_catalog.sql`（已含 models 新列与 usage_records.cost_micro 可空）。

---

## 1. models 新列（迁移 003）

| 列 | 类型 | 取值/默认 | 语义 |
|---|---|---|---|
| `source` | text | `seeded`(默认) / `discovered` / `manual` | 来源：种子策展 / 接口发现 / 管理员手工 |
| `lifecycle` | text | `active`(默认) / `deprecated` / `hidden` | 生命周期：可用 / 退役停用 / 人工隐藏 |
| `first_seen_at` | timestamptz | | 首次出现时间 |
| `last_seen_at` | timestamptz | | 最近一次在列模型接口中出现 |
| `last_checked_at` | timestamptz | | 最近一次健康探测 |
| `capabilities_verified` | boolean | false | 能力是否经人工/探测确认 |
| `deprecation_reason` | text | null | 停用原因 |
| `miss_count` | int | 0 | 连续同步未出现次数（达阈值才停用） |

索引：`idx_models_lifecycle(lifecycle)`、`idx_models_source(source)`。
种子行：`source=seeded, lifecycle=active, capabilities_verified=true`。
`usage_records.cost_micro` 改为**可空**：NULL = 成本未知（价格缺失），区别于 0。

---

## 2. 适配器 listModels()（可选能力）

在 `BaseModelAdapter` 增加实例方法（非抽象，默认返回 unsupported）：

```
async listModels({ apiKey, baseUrl, timeoutMs, signal }) ->
  { supported: true,  models: [ "<providerModelId>", ... ] }
  | { supported: false, reason: "unsupported" | "no_credential" | "not_found", status }
```

实现口径：

| 供应商 | 方法/端点 | 解析 |
|---|---|---|
| openai / deepseek / qwen / zhipu / doubao / kimi / custom | `GET {base}/models`（Bearer） | `data[].id` |
| gemini | `GET {base}/v1beta/models?key=` | `models[].name` 去掉前缀 `models/` |
| anthropic | 无公开列模型接口 | 恒 `{supported:false, reason:'unsupported'}`，保留种子目录 |

- 404 / 405 / 明确不支持 → 优雅降级为 `{supported:false}`，**不得让整次发现失败**。
- 统一走 transport（超时/取消/错误映射）；鉴权失败(401/403) → `{supported:false, reason:'auth'}`（等同无可用凭证，跳过）。
- 仅取 id 字符串，去空白、去重；不臆测能力/价格。
- 单测：OpenAI 与 Gemini 两类解析样本（含分页/空 data）、anthropic 不支持、404/405 降级、401 降级，全部 mock。

---

## 3. discovered 模型的保守默认能力（写入 model_capabilities）

**OpenAI 兼容**（toolCallFormat `openai`）：

```json
{
  "supportsStreaming": true,
  "supportsTools": true,
  "supportsVision": false,
  "supportsSystemPrompt": true,
  "supportsThinking": false,
  "supportsStructuredOutput": true,
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "inputModalities": ["text"],
  "outputModalities": ["text"],
  "toolCallFormat": "openai",
  "conservativeDefaults": true
}
```

**Gemini**（toolCallFormat `gemini`）：streaming/systemPrompt/tools=true；vision/thinking=false；structuredOutput=false；contextWindow=32768；maxOutputTokens=4096；inputModalities=["text"]。

原则：vision/thinking 绝不臆测为 true；上下文未知用保守值；**价格一律不写（pricing_versions 无行）**。新行 `source='discovered', lifecycle='active', capabilities_verified=false, first_seen_at=last_seen_at=now()`。

新模型 id 规则：`mdl_disc_<provider>_<稳定哈希/自增>`，保证全局唯一且不与种子 id 冲突；slug 存供应商原生 id；display_name 初始为该原生 id（管理员可改名）。

---

## 4. CatalogDiscovery（自动发现服务）

模块：`src/core/discovery/catalogDiscovery.js`，工厂 `createCatalogDiscovery(deps)`，deps 可注入 transport/registry（测试 mock）。

### 凭证来源（隐私边界）

| 触发方 | 凭证 |
|---|---|
| 手动（管理员调 sync） | ① 优先**该管理员**在各供应商已保存的解密凭证；② 其次平台共享 key（`getPlatformKey`）；③ 都没有 → 跳过该供应商 |
| 启动 / interval / cron | **只用平台 key**；无则跳过。**绝不读取任何普通用户凭证** |

base URL：用户凭证自带 baseUrl（自定义），否则平台 base，否则适配器默认。

### Diff 规则（逐供应商，错误隔离）

- 上游 id 集合 = listModels 结果。
- **新 id（models 表无该 provider+slug）** → 插入 discovered 行（保守能力、**无价格**）。
- **已存在（同 provider+slug，任意 source）** → 更新 `last_seen_at=now()`、`miss_count=0`；若此前被误判 deprecated 且本次出现，回 active（清 reason）。
- **seeded / manual 模型本次未列出 → 不停用、不增 miss**（人工策展，不应被接口波动影响）。
- **discovered 模型本次未列出** → `miss_count += 1`；当 `miss_count >= CATALOG_DEPRECATE_AFTER_MISSES`（默认 2）→ `lifecycle='deprecated'`，`deprecation_reason` 如 `连续 N 次同步未列出（最近 <ranAt>）`。未达阈值保持 active。
- 幂等：重复运行不产生重复行、不重复计数到越界。

### 返回汇总

```json
{
  "ranAt": "...", "trigger": "startup|interval|manual|cron", "durationMs": 0,
  "providers": {
    "openai": { "queried": true, "supported": true, "seen": 3, "added": 1,
      "updated": 2, "markedDeprecated": 0, "skipped": false, "skipReason": null, "error": null },
    "anthropic": { "queried": true, "supported": false, "seen": 0, "added": 0,
      "updated": 0, "markedDeprecated": 0, "skipped": true, "skipReason": "unsupported", "error": null }
  },
  "totals": { "providers": 8, "queried": 6, "added": 1, "seen": 20, "markedDeprecated": 1, "skipped": 2 }
}
```

无任何可用 key：所有供应商 `skipped, skipReason='no_credential'`，**整体成功、不抛错**。

---

## 5. ModelHealthProbe（自动停用探测）

模块：`src/core/discovery/modelHealthProbe.js`。

- 仅对**有凭证**的供应商、对其 active 模型逐个发最小无害请求（内容 `"hi"`，`max_tokens=1`，stream 关闭）；并发受 `MODEL_PROBE_CONCURRENCY` 限制，自带节流。
- **只有明确退役/不存在信号才停用**：HTTP 404；或 HTTP 400 且错误 code/文案命中
  `model_not_found`、`does not exist`、`not found`、`deprecated`、`decommissioned`、`已下线`、`不存在`、`已停用` 等（大小写不敏感，匹配 code 与 message）。
  → `lifecycle='deprecated'`，`deprecation_reason='探测判定退役: <原文>'`。
- **以下一律保持 active**，仅更新 `last_checked_at`：401/403（鉴权）、402（欠费）、429（限流）、网络错误、5xx、超时、取消、以及无法判定的 400。
- 停用**可逆**：管理员 PATCH 改回 active 即恢复。
- 探测使用平台/触发管理员 key；**不向普通用户计费、不写该用户用量**；探测产生的极少量 token 不计入用户账单。
- 单测：退役(404 / 400 各文案) → deprecated；401/402/429/5xx/超时 → 保持 active 且更新 last_checked_at。

返回：

```json
{ "ranAt": "...", "trigger": "manual|startup",
  "models": { "mdl_x": { "outcome": "deprecated|keptActive|error", "httpStatus": 404, "reason": "..." } },
  "totals": { "checked": 10, "deprecated": 1, "keptActive": 8, "errors": 1 } }
```

---

## 6. 触发方式

- **启动**：`server.js` 在 listen 后 `setTimeout(CATALOG_DISCOVERY_STARTUP_DELAY_MS)` 非阻塞跑一次发现；失败只 console.warn，绝不影响启动/健康检查。
- **interval**：`CATALOG_DISCOVERY_INTERVAL_HOURS>0` 时 `setInterval` 周期发现（默认 24h）。免费实例休眠期间不运行，唤醒后不补跑（文档写明）。
- 保存最近一次 discovery / probe 结果（内存单例即可，status 接口读取）。

### 管理员 API（挂在现有 `/api/admin` 路由内，已过 requireAuth + 新 requireAdmin；非管理员 403）

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| POST `/catalog/sync` | `{probe?:bool}` | 发现汇总（§4）；probe=true 同步再跑探测 |
| POST `/catalog/probe` | — | 探测汇总（§5） |
| GET `/catalog/status` | — | 见下 |
| PATCH `/models/:id` | 见下 | 更新后的 catalog 模型条目 |

GET `/catalog/status`：

```json
{
  "lastDiscovery": { "ranAt": "...", "trigger": "...", "totals": {} },
  "lastProbe": { "ranAt": "...", "totals": {} },
  "discovered": [ { "id","provider","slug","displayName","lifecycle","capabilitiesVerified","pricing","firstSeenAt","lastSeenAt" } ],
  "deprecated": [ { "id","provider","slug","displayName","deprecationReason" } ],
  "pendingPricing": [ { "id","provider","slug","displayName" } ]
}
```

PATCH `/models/:id`（字段均可选）：

```json
{
  "lifecycle": "active|deprecated|hidden",
  "deprecationReason": "string|null",
  "capabilities": { "supportsVision": true },
  "contextWindow": 128000,
  "maxOutputTokens": 16384,
  "capabilitiesVerified": true,
  "displayName": "新名称",
  "pricing": { "inputMicroPerMtok": 1070000, "outputMicroPerMtok": 4260000, "currency": "CNY" }
}
```

- capabilities 为**合并**（JSON merge）；contextWindow/maxOutputTokens 写入 capabilities。
- pricing：对当前价（effective_to IS NULL）upsert；无则新建一条 `effective_from=now()` 的 pricing_versions（写迁移 002 的部分唯一索引保证当前价唯一）。
- 重新启用：`lifecycle='active'`，清 deprecationReason、miss_count=0。
- 手工改动的行 source 置 `manual`（除非本就是 seeded 且仅补价——补价不改 source）。

### Cron（可选，公开但需签名）

- 端点：`POST /api/cron/catalog-sync`（**不挂** requireAdmin）。
- 校验头 `X-Cron-Secret: <CRON_SECRET>`；不匹配 → 401。
- `CRON_SECRET` 未配置 → 端点返回 503（避免未鉴权触发）。
- 触发平台 key 发现（可选 body `{probe:true}`），返回汇总。
- render.yaml 增加**可选** Cron Job（schedule 如 `0 6 * * *`，POST 该 URL，header 带 secret）；不影响 web/主流程。

---

## 7. catalog API 与前端口径

- `GET /api/catalog`：每个模型新增 `source, lifecycle, capabilitiesVerified, firstSeenAt, lastSeenAt, lastCheckedAt, deprecationReason`。
- **默认过滤** `lifecycle IN ('deprecated','hidden')`；`?include_deprecated=true` 时返回全部。
- pricing 为 null 时保持 `pricing:null`（不得填 0）。
- 前端：
  - 模型选择器隐藏 deprecated/hidden；
  - discovered（capabilitiesVerified=false）显示角标「新发现·能力待验证」；
  - pricing=null：显示「价格待补充」，费用列显示「未知」，**绝不显示 ¥0 或假价**；
  - 设置页管理员区：「立即同步模型目录」「立即探测」按钮 + 新发现清单、已停用清单；每条可补能力/上下文/价格、启用/停用（调 PATCH /admin/models/:id）。

---

## 8. 计费完整性（硬约束）

- discovered/manual 且无当前 pricing_versions → 价格未知；
- 用量照常记录 prompt/completion tokens；
- `usage_records.cost_micro = NULL`（未知），在管理员补价前不得写 0 或任何估算假价；
- usage 汇总对 NULL 的处理：成本汇总只累加非 NULL，并另给 `unknownCostCalls` 计数（前端据此显示「N 次费用待核算」），不得把 NULL 当 0 拉低总额。

---

## 9. 归属边界（避免文件冲突）

- **后端发现单元**：`src/adapters/*.js`（仅加 listModels，不改既有流式逻辑）、`src/adapters/base.js`（加默认 listModels）、`src/core/discovery/*`（新建）、`src/routes/admin.routes.js`（加 catalog/model 路由）、新增 cron 路由（在 app.js 挂载 `/api/cron`）、`src/server.js`（启动/interval）、`render.yaml`、对应测试 `test/discovery/*` 与 `test/adapters/listModels`。
- **前端/catalog 单元**：仅 `src/routes/catalog.routes.js` 与 `src/public/index.html`。
- 公共：迁移 003、config、admin 判定、.env.example 已由 Organizer 落地，两单元直接使用，不再修改。
