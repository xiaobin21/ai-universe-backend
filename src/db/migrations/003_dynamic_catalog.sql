-- 003_dynamic_catalog.sql
-- 动态模型目录：自动发现 + 自动停用所需的来源、生命周期与探测字段。
--
-- 可重复执行：全部使用 ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS；
--             数据回填用 WHERE 条件收敛，二次执行不再改动已发现(manual/discovered)行。
-- 事务安全：本文件在单个事务内执行，任一语句失败整体回滚（PostgreSQL 支持事务性 DDL）。
--
-- 【手动回滚（down）】如需撤销本迁移，在 psql 执行：
--   DROP INDEX IF EXISTS idx_models_lifecycle;
--   DROP INDEX IF EXISTS idx_models_source;
--   UPDATE usage_records SET cost_micro=0 WHERE cost_micro IS NULL;
--   ALTER TABLE usage_records ALTER COLUMN cost_micro SET NOT NULL;
--   ALTER TABLE models
--     DROP COLUMN IF EXISTS miss_count,
--     DROP COLUMN IF EXISTS deprecation_reason,
--     DROP COLUMN IF EXISTS capabilities_verified,
--     DROP COLUMN IF EXISTS last_checked_at,
--     DROP COLUMN IF EXISTS last_seen_at,
--     DROP COLUMN IF EXISTS first_seen_at,
--     DROP COLUMN IF EXISTS lifecycle,
--     DROP COLUMN IF EXISTS source;
--   DELETE FROM schema_migrations WHERE version='003_dynamic_catalog.sql';

-- 1) 来源：seeded=种子人工策展 | discovered=接口自动发现 | manual=管理员手工录入
ALTER TABLE models ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seeded';
DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT chk_models_source
    CHECK (source IN ('seeded','discovered','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) 生命周期：active=可用 | deprecated=已停用/退役（默认在目录中隐藏）| hidden=人工隐藏
ALTER TABLE models ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'active';
DO $$ BEGIN
  ALTER TABLE models ADD CONSTRAINT chk_models_lifecycle
    CHECK (lifecycle IN ('active','deprecated','hidden'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) 发现/探测时间戳
ALTER TABLE models ADD COLUMN IF NOT EXISTS first_seen_at   timestamptz;
ALTER TABLE models ADD COLUMN IF NOT EXISTS last_seen_at    timestamptz;
ALTER TABLE models ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;

-- 4) 能力是否已验证；停用原因；连续未出现计数（达到阈值才自动停用）
ALTER TABLE models ADD COLUMN IF NOT EXISTS capabilities_verified boolean NOT NULL DEFAULT false;
ALTER TABLE models ADD COLUMN IF NOT EXISTS deprecation_reason text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS miss_count integer NOT NULL DEFAULT 0;

-- 4b) 计费完整性：discovered 模型在管理员补价前“成本未知”，cost_micro 允许 NULL（区别于 0 元）。
ALTER TABLE usage_records ALTER COLUMN cost_micro DROP NOT NULL;

-- 5) 现有种子行标记为 seeded / active / 已验证，并补时间戳。
--    仅收敛“仍为默认值且未验证”的行，避免二次执行或后续 discovered/manual 行被误改。
UPDATE models
   SET source='seeded',
       lifecycle='active',
       capabilities_verified=true,
       first_seen_at=COALESCE(first_seen_at, now()),
       last_seen_at=COALESCE(last_seen_at, now())
 WHERE capabilities_verified=false AND source='seeded';

-- 6) 索引（按生命周期过滤、按来源统计）
CREATE INDEX IF NOT EXISTS idx_models_lifecycle ON models(lifecycle);
CREATE INDEX IF NOT EXISTS idx_models_source    ON models(source);
