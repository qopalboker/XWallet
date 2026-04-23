-- ═══════════════════════════════════════════════════════════════════════
-- Migration 009: benchmark_allowed flag
--
-- Benchmark mode می‌تونه ۱۰۰ هزار balance check بزنه. GetBlock تیر رایگان
-- روزانه ۵۰k CU داره — یه benchmark run کل سهمیهٔ روز رو می‌خوره و
-- traffic واقعی تا فردا می‌افته. این flag یه credential رو از
-- benchmark استخرار خارج می‌کنه (ولی روی balance flow عادی می‌مونه).
--
-- Default = true برای backwards compat (کلیدهای دستی Alchemy و غیره
-- برای benchmark قابل استفاده می‌مونن). GetBlock importer روی insert
-- false می‌ذاره.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE api_credentials
  ADD COLUMN IF NOT EXISTS benchmark_allowed BOOLEAN NOT NULL DEFAULT true;

-- Indexی که pickCredential با forBenchmark=true از حافظه می‌گیره چون ما
-- in-memory cache داریم، ایندکس فقط برای query های ad-hoc مفیده.
CREATE INDEX IF NOT EXISTS idx_api_credentials_benchmark
  ON api_credentials(provider, benchmark_allowed)
  WHERE is_active = true;
