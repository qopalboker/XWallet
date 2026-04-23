-- ═══════════════════════════════════════════════════════════════════════
-- Migration 010: ستون address_type برای BTC
--
-- پیش‌فرض کیف‌پول‌های مدرن (Trust, MetaMask, …) Native SegWit (m/84')
-- هست، ولی ولت‌های قدیمی‌تر هنوز Legacy (m/44', آدرس 1…) یا P2SH-
-- wrapped SegWit (m/49', آدرس 3…) دارن. اگه کاربری یکی از این‌ها رو
-- import کنه و ما فقط m/84' رو چک کنیم، موجودی‌ش رو نمی‌بینه.
--
-- این ستون نوع BTC address رو مشخص می‌کنه ('segwit'|'p2sh'|'legacy')
-- و برای chain های غیر BTC همیشه NULL می‌مونه. چون نمیشه دو UNIQUE
-- constraint روی یه جدول گذاشت که NULLها رو متفاوت هندل کنن، constraint
-- قدیمی (wallet_id, chain, derivation_index) رو drop می‌کنیم و یه
-- constraint جدید با chain-aware uniqueness می‌ذاریم.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS address_type VARCHAR(16);

-- backfill: همه BTC های موجود segwit بودن (path m/84' default بوده)
UPDATE addresses
   SET address_type = 'segwit'
 WHERE chain = 'BTC' AND address_type IS NULL;

-- constraint: فقط برای BTC مقدار معتبر باشه؛ برای غیر BTC باید NULL بمونه
ALTER TABLE addresses
  DROP CONSTRAINT IF EXISTS addresses_btc_address_type_check;

ALTER TABLE addresses
  ADD CONSTRAINT addresses_btc_address_type_check
    CHECK (
      (chain = 'BTC' AND address_type IN ('segwit', 'p2sh', 'legacy'))
      OR (chain <> 'BTC' AND address_type IS NULL)
    );

-- UNIQUE قدیمی (wallet_id, chain, derivation_index) اجازه نمی‌ده یه ولت
-- سه نوع BTC با یه index داشته باشه. حذف و جایگزین با یه UNIQUE که نوع
-- رو هم در نظر بگیره. برای ETH/TRON که NULL هست، (wallet_id, chain,
-- derivation_index, NULL) ست‌های مختلف محسوب می‌شن — پس یه partial
-- unique جدا هم براشون لازمه.
ALTER TABLE addresses
  DROP CONSTRAINT IF EXISTS addresses_wallet_id_chain_derivation_index_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_addresses_btc_wallet_idx_type
  ON addresses(wallet_id, derivation_index, address_type)
  WHERE chain = 'BTC';

CREATE UNIQUE INDEX IF NOT EXISTS uq_addresses_nonbtc_wallet_chain_idx
  ON addresses(wallet_id, chain, derivation_index)
  WHERE chain <> 'BTC';
