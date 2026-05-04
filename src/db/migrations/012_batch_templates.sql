-- ═══════════════════════════════════════════════════════════════════════
-- 012_batch_templates.sql
--
-- Auto-batch / scheduled-job templates.
--
-- یه «template» مشخصاتِ یک batch generation رو ذخیره می‌کنه که می‌تونه:
--   - manual: فقط با دکمهٔ Run Now اجرا بشه
--   - on_startup: هر بار که worker بالا میاد یک‌بار اجرا بشه (با cooldown ساعتی)
--   - cron: روی یک الگوی cron به‌صورت repeatable توسط BullMQ اجرا بشه
--
-- spec_json شکل:
--   { "wordCount": 12|24, "addressesPerWallet": 1..20, "count": 1..10000,
--     "startUserId": int?, "chunkSize": 1..5000? }
-- اعتبارسنجی شکل تو سرویس انجام می‌شه؛ این‌جا فقط JSONB ست.
--
-- last_run_at و last_job_id برای دو هدف:
--   1) UI نشون بده آخرین اجرا کِی و چه job ای بوده
--   2) on_startup gate: اگه last_run_at تو cooldown_hours گذشته بود، skip کن
--
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS batch_templates (
    id              BIGSERIAL    PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    enabled         BOOLEAN      NOT NULL DEFAULT true,
    spec_json       JSONB        NOT NULL,
    trigger_type    VARCHAR(20)  NOT NULL
                    CHECK (trigger_type IN ('on_startup', 'cron', 'manual')),
    cron_expr       VARCHAR(100),
    -- برای on_startup: حداقل فاصلهٔ ساعتی بین دو اجرا (روی worker restart دوباره
    -- fire نشه). 0 = همیشه fire. NULL = پیش‌فرض ۲۴h توی کد.
    cooldown_hours  INTEGER,
    last_run_at     TIMESTAMPTZ,
    last_job_id     BIGINT       REFERENCES generation_jobs(id) ON DELETE SET NULL,
    created_by      BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE(name)
);

CREATE INDEX IF NOT EXISTS idx_batch_templates_enabled_trigger
    ON batch_templates(trigger_type, enabled)
    WHERE enabled = true;

-- اگه trigger_set_updated_at از قبل از schema.sql لود شده، فقط trigger رو می‌بندیم.
DROP TRIGGER IF EXISTS set_batch_templates_updated_at ON batch_templates;
CREATE TRIGGER set_batch_templates_updated_at
    BEFORE UPDATE ON batch_templates
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ─── system_settings: کلید-مقدار ساده برای feature flag/circuit breaker ───
-- AUTO_BATCH_ENABLED اولیه = 'true'. با env قابل override (env wins اگه ست باشه).
CREATE TABLE IF NOT EXISTS system_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT         NOT NULL,
    updated_by  BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
VALUES ('auto_batch_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
