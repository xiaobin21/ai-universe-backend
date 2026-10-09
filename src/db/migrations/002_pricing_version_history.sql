-- 002: 修正 pricing_versions 的唯一性约束，支持「多历史版本 + 单一当前版本」。
-- 原 001 的 UNIQUE(provider, model) 会阻止同一模型保留多条调价历史，改为：
--   仅对“当前版本”（effective_to IS NULL）在 (provider, model) 上唯一。

ALTER TABLE pricing_versions
  DROP CONSTRAINT IF EXISTS pricing_versions_provider_model_key;

CREATE UNIQUE INDEX IF NOT EXISTS pricing_versions_current_uniq
  ON pricing_versions (provider, model)
  WHERE effective_to IS NULL;
