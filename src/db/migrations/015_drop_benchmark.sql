-- ═══════════════════════════════════════════════════════════════════════
-- Migration 015: حذف کامل Benchmark Mode
--
-- جدول benchmark_runs و ستون benchmark_allowed (با index متناظر) از
-- api_credentials کاملاً حذف می‌شن.
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_api_credentials_benchmark;
ALTER TABLE api_credentials DROP COLUMN IF EXISTS benchmark_allowed;

DROP INDEX IF EXISTS idx_benchmark_runs_status;
DROP INDEX IF EXISTS idx_benchmark_runs_created;
DROP TABLE IF EXISTS benchmark_runs;
