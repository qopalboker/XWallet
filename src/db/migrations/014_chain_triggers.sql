-- ═══════════════════════════════════════════════════════════════════════
-- 014_chain_triggers.sql
--
-- Replace the on_startup/cron/manual trigger model with a single
-- chain-on-completion model:
--
--   When a batch from a template finishes, the next batch from the
--   same template spawns automatically. The chain runs until an
--   operator pauses it.
--
-- Schema impact:
--
--   batch_templates
--     + status            VARCHAR(10)  ('active' | 'paused')
--     + cooldown_seconds  INTEGER      (delay between spawns)
--     - trigger_type, cron_expr, cooldown_hours, enabled
--
--   generation_jobs
--     + template_id       BIGINT  (which template spawned this run)
--     + parent_job_id     BIGINT  (the run whose completion spawned this one)
--
-- Production safety: every existing batch_templates row migrates to
-- status='paused'. Chain semantics are not equivalent to the old
-- trigger semantics — silently auto-converting a daily-cron template
-- to a chain-on-completion template would change behavior in ways the
-- operator hasn't reviewed. They re-enable each chain explicitly via
-- the admin panel after deploy.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE batch_templates
  ADD COLUMN status            VARCHAR(10) NOT NULL DEFAULT 'paused'
    CHECK (status IN ('active', 'paused')),
  ADD COLUMN cooldown_seconds  INTEGER     NOT NULL DEFAULT 0
    CHECK (cooldown_seconds >= 0);

DROP INDEX IF EXISTS idx_batch_templates_enabled_trigger;

ALTER TABLE batch_templates
  DROP CONSTRAINT IF EXISTS batch_templates_trigger_type_check,
  DROP COLUMN IF EXISTS trigger_type,
  DROP COLUMN IF EXISTS cron_expr,
  DROP COLUMN IF EXISTS cooldown_hours,
  DROP COLUMN IF EXISTS enabled;

CREATE INDEX idx_batch_templates_status_active
  ON batch_templates(status)
  WHERE status = 'active';

ALTER TABLE generation_jobs
  ADD COLUMN template_id   BIGINT REFERENCES batch_templates(id) ON DELETE SET NULL,
  ADD COLUMN parent_job_id BIGINT REFERENCES generation_jobs(id) ON DELETE SET NULL;

-- Idempotency guard: a parent job can spawn at most one child. If a
-- finalize handler races (BullMQ redelivery, two workers, retry), the
-- second INSERT with the same parent_job_id raises 23505 and the
-- spawn handler treats that as "already chained, no-op."
-- The partial WHERE clause keeps NULL parent_job_id values (ad-hoc
-- jobs and first-in-chain rows) outside the constraint.
CREATE UNIQUE INDEX idx_generation_jobs_parent_unique
  ON generation_jobs(parent_job_id)
  WHERE parent_job_id IS NOT NULL;
