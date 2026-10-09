-- 001_init.sql —— 初始 schema（契约 §5.1，全部 20 张表）
-- 幂等：所有对象 IF NOT EXISTS；可重复执行。
-- 主键统一 TEXT（应用生成带前缀 id）；时间 TIMESTAMPTZ 默认 now()；金额 BIGINT（micro 整数）。

-- ============ 账号与会话 ============
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'free',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  ip                 TEXT,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  routing_mode        TEXT NOT NULL DEFAULT 'manual',
  default_model_id    TEXT,
  budget_daily_micro  BIGINT NOT NULL DEFAULT 10000000,
  max_output_tokens   INTEGER NOT NULL DEFAULT 4096
);

-- ============ 对话与消息 ============
CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT,
  model_id         TEXT,
  current_branch_id TEXT,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS message_branches (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_message_id TEXT,
  branch_index      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_branches_conv ON message_branches(conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role               TEXT NOT NULL,
  branch_id          TEXT REFERENCES message_branches(id),
  parent_message_id  TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',
  job_id             TEXT,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id);

CREATE TABLE IF NOT EXISTS message_parts (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_parts_message ON message_parts(message_id);

-- ============ 生成任务与事件 ============
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                     TEXT PRIMARY KEY,
  message_id             TEXT REFERENCES messages(id) ON DELETE SET NULL,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'queued',
  request_id              TEXT,
  idempotency_key         TEXT,
  cancel_requested_at     TIMESTAMPTZ,
  cancel_acknowledged_at TIMESTAMPTZ,
  upstream_closed_at      TIMESTAMPTZ,
  error_code             TEXT,
  error_message          TEXT,
  usage_id               TEXT,
  started_at             TIMESTAMPTZ,
  finished_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON generation_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_message ON generation_jobs(message_id);

CREATE TABLE IF NOT EXISTS generation_events (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);

-- ============ 供应商、凭证、模型目录 ============
CREATE TABLE IF NOT EXISTS providers (
  id                TEXT PRIMARY KEY,
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  default_base_url  TEXT,
  kind              TEXT NOT NULL DEFAULT 'openai',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  circuit_open      BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id           TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  encrypted_credentials  TEXT,
  masked_hint           TEXT,
  base_url              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at            TIMESTAMPTZ,
  UNIQUE (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS models (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  slug         TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

CREATE TABLE IF NOT EXISTS model_capabilities (
  id         TEXT PRIMARY KEY,
  model_id   TEXT UNIQUE NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============ 附件与工具 ============
CREATE TABLE IF NOT EXISTS attachments (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  storage_key    TEXT NOT NULL,
  mime           TEXT,
  size_bytes     BIGINT,
  parse_status   TEXT NOT NULL DEFAULT 'pending',
  parsed_text_ref TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  args_json   JSONB,
  result_json JSONB,
  status      TEXT NOT NULL DEFAULT 'pending',
  duration_ms BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);

-- ============ 计费与价格 ============
CREATE TABLE IF NOT EXISTS usage_records (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id           TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  prompt_tokens    BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro       BIGINT NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'CNY',
  usage_source     TEXT NOT NULL DEFAULT 'estimated',
  priced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_user_priced ON usage_records(user_id, priced_at);
CREATE INDEX IF NOT EXISTS idx_usage_idem ON usage_records(idempotency_key);

CREATE TABLE IF NOT EXISTS pricing_versions (
  id                              TEXT PRIMARY KEY,
  provider                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  effective_from                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to                    TIMESTAMPTZ,
  input_price_micro_per_mtok     BIGINT NOT NULL,
  output_price_micro_per_mtok    BIGINT NOT NULL,
  currency                        TEXT NOT NULL DEFAULT 'CNY',
  UNIQUE (provider, model)
);

-- ============ 幂等 / 模板 / 审计 ============
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id         TEXT PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT,
  job_id     TEXT,
  status     TEXT NOT NULL DEFAULT 'processing',
  result_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  ip         TEXT,
  meta_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
