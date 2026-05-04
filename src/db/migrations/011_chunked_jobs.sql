-- ═══════════════════════════════════════════════════════════════════════
-- 011_chunked_jobs.sql
--
-- Generation_jobs اکنون می‌تونه به چند chunk تقسیم بشه (هر chunk = یه
-- BullMQ job مستقل). همه chunk‌ها یه ردیف parent مشترک به‌روزرسانی می‌کنن.
--
-- ستون‌های جدید:
--   chunks_total         — تعداد کل chunk‌ها (1 برای backward compat)
--   chunks_done          — chunk هایی که finalize شدن (atomic increment)
--   failed_count         — مجموع wallet‌های failed تو همه chunk‌ها
--   addresses_per_wallet — برای reproducibility (فعلاً diagnostics)
--   start_user_id        — برای trace/debug
--
-- وضعیت نهایی job (completed/partial/failed) فقط وقتی ست می‌شه که
-- chunks_done >= chunks_total. منطقش تو generation worker اعمال می‌شه.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE generation_jobs
    ADD COLUMN IF NOT EXISTS chunks_total INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS chunks_done  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS addresses_per_wallet INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS start_user_id BIGINT;

-- داشبورد و jobs page زیاد بر اساس (status, created_at) فیلتر می‌کنن.
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created
    ON generation_jobs(status, created_at DESC);
