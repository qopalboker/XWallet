-- ═══════════════════════════════════════════════════════════════════════
-- Migration 008: Cleanup dead btc_rpc provider
--
-- تو PR اول GetBlock اضافه شد، توکن‌های BTC تحت provider='btc_rpc'
-- وارد می‌شدن. ولی هیچ consumer ای براش نبود (balance check ما از
-- mempool.space استفاده می‌کنه، broadcast هم هنوز نداریم). ردیف‌های
-- ذخیره‌شده فقط surface حمله بدون سود بودن، پس حذف می‌شن.
--
-- اگه تو آینده BTC broadcast اضافه شد، GetBlock رو می‌تونیم دوباره
-- وصل کنیم (رجوع به TODO داخل src/services/getblock.ts).
-- ═══════════════════════════════════════════════════════════════════════

DELETE FROM api_credentials WHERE provider = 'btc_rpc';
