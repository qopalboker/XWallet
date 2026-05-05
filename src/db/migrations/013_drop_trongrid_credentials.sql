-- ═══════════════════════════════════════════════════════════════════════
-- TronGrid credential rows are no longer consumed.
--
-- src/balance/tron.ts moved to the keyless /wallet/* full-node API on
-- api.tronstack.io (with api.trongrid.io as fallback). No code path
-- reads `provider='trongrid'` rows from api_credentials anymore.
-- Drop them so they don't linger as ghost entries in the admin panel.
-- ═══════════════════════════════════════════════════════════════════════

DELETE FROM api_credentials WHERE provider = 'trongrid';
