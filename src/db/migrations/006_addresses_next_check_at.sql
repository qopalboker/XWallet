-- ═══════════════════════════════════════════════════════════════════════
-- Migration 006: زمان‌بندی چک موجودی با next_check_at
--
-- قبلاً priority (0/1/2) داشتیم و هر سه repeatable job جدا.
-- حالا یه ستون next_check_at داریم که timestamp بعدی رو نگه می‌داره
-- و یه single worker repeatable job همه آدرس‌های due رو می‌گیره.
--
-- backfill: همه آدرس‌های موجود NOW() ست می‌شن (یعنی الان due هستن).
-- priority هنوز نگه می‌داریم برای backwards compat ولی primary scheduling
-- از next_check_at استفاده می‌کنه.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;

UPDATE addresses
   SET next_check_at = COALESCE(last_checked_at, NOW())
 WHERE next_check_at IS NULL;

ALTER TABLE addresses
  ALTER COLUMN next_check_at SET DEFAULT NOW(),
  ALTER COLUMN next_check_at SET NOT NULL;

-- index سبک برای انتخاب آدرس‌های due
CREATE INDEX IF NOT EXISTS idx_addresses_next_check_due
  ON addresses(next_check_at)
  WHERE status = 'active';

-- index قدیمی priority+last_checked_at دیگه استفاده نمی‌شه ولی اگه DB
-- محصولی پر باشه drop سنگینه — می‌ذاریم باشه.
