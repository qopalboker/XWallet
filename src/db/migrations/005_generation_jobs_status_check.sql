-- ═══════════════════════════════════════════════════════════════════════
-- Migration 005: CHECK constraint روی generation_jobs.status
--
-- worker می‌تونه 'partial' هم برگردونه (وقتی بعضی از ولت‌ها fail شدن)،
-- پس constraint باید این مقدار رو هم قبول کنه.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE generation_jobs
  ADD CONSTRAINT chk_generation_jobs_status
  CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'));
