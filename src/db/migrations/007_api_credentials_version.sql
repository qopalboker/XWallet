-- ═══════════════════════════════════════════════════════════════════════
-- Migration 007: encryption_version برای api_credentials
--
-- مثل جدول wallets، حالا credentials هم می‌تونن با key rotation versioned
-- شن. ردیف‌های موجود به‌صورت پیش‌فرض version=1 می‌گیرن.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE api_credentials
  ADD COLUMN IF NOT EXISTS encryption_version SMALLINT NOT NULL DEFAULT 1;
