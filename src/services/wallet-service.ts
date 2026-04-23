/**
 * Wallet Service — orchestrator
 *
 * طراحی tx ها:
 *   createWallet:        یه tx (mnemonic random تازه‌ست، derivation سریع)
 *   getNewDepositAddress:
 *     1) tx کوتاه: UPDATE...RETURNING برای reserve کردن index بعدی + خوندن mnemonic
 *     2) خارج tx: decrypt + derivation (می‌تونه کند باشه: PBKDF2)
 *     3) خارج tx: INSERT INTO addresses (single statement)
 *     این جلوی نگه‌داشتن طولانی row lock رو می‌گیره. اگه INSERT (مرحله 3)
 *     fail کنه، یه gap توی index‌ها ایجاد می‌شه که OK هست (gaps مشکلی ندارن).
 *
 * Lazy key rotation:
 *   هر بار mnemonic decrypt می‌شه، اگه version قدیمی باشه با version فعلی
 *   re-encrypt و row update می‌شه (best-effort، اگه fail کنه error log می‌شه).
 */

import { pool } from '../db/pool.js';
import {
  generateMnemonic,
  deriveMany,
  deriveBtcAllTypes,
  isValidMnemonic,
  normalizeMnemonic,
  type Chain,
  type DerivedAddress,
} from '../wallet/derivation.js';
import {
  encryptMnemonic,
  decryptMnemonic,
  maybeReEncrypt,
  type EncryptedMnemonic,
} from '../crypto/aes.js';
import { batchBtcBalances } from '../balance/btc.js';

const ALL_CHAINS: Chain[] = ['BTC', 'ETH', 'TRON'];

// سقف scan برای import — تا این تعداد index از هر نوع BTC (legacy/p2sh)
// آدرس می‌سازیم و بالانس می‌گیریم. اگه بیشتر از این خواست، کاربر باید
// initial_address_count بزرگ‌تر بفرسته.
const BTC_LEGACY_SCAN_MIN = 5;

export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  readonly statusCode = 404;
  constructor(walletId: number) {
    super(`wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class InvalidMnemonicError extends Error {
  readonly code = 'INVALID_MNEMONIC';
  readonly statusCode = 400;
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidMnemonicError';
  }
}

export interface CreateWalletOptions {
  userId: number;
  wordCount?: 12 | 24;
  initialAddressCount?: number;
}

export interface CreateWalletResult {
  walletId: number;
  addresses: DerivedAddress[];
}

export async function createWallet(
  opts: CreateWalletOptions
): Promise<CreateWalletResult> {
  const { userId, wordCount = 12, initialAddressCount = 1 } = opts;

  if (initialAddressCount < 1 || initialAddressCount > 100) {
    throw new Error('initialAddressCount باید بین 1 و 100 باشه');
  }

  const mnemonic = generateMnemonic(wordCount);
  return persistWallet(userId, mnemonic, wordCount, initialAddressCount);
}

export interface ImportWalletOptions {
  userId: number;
  mnemonic: string;
  initialAddressCount?: number;
  // اگه true باشه، legacy (m/44') و p2sh (m/49') BTC آدرس‌های اولیه رو
  // هم scan می‌کنه و اگه موجودی داشته باشن به DB می‌افزاد. default: true.
  scanLegacyBtc?: boolean;
}

export interface ImportWalletResult extends CreateWalletResult {
  legacyBtc: {
    scanned: number;         // تعداد کل آدرس‌های legacy+p2sh که چک شدن
    detected: DerivedAddress[]; // اون‌هایی که موجودی داشتن (قبل از persist)
    skipped?: boolean;       // اگه scan به هر دلیلی انجام نشد (network error و …)
  };
}

/**
 * Import یه wallet موجود از mnemonic کاربر.
 *
 * نرمال‌سازی و validation:
 *   - NFKD + trim + collapse whitespace + lowercase (normalizeMnemonic)
 *   - تعداد کلمات: فقط 12 یا 24
 *   - checksum + wordlist (bip39.validateMnemonic)
 *
 * BTC legacy/p2sh scan:
 *   کاربرانی که از Trust قدیمی، Electrum legacy یا هر ولت pre-2020 دیگه
 *   mnemonic میارن ممکنه موجودی‌شون روی آدرس‌های m/44' (1…) یا m/49' (3…)
 *   باشه. اگه ما فقط m/84' (bc1…) رو چک کنیم، کاربر فکر می‌کنه موجودی‌ش
 *   گم شده. این scan اون دو نوع آدرس رو هم می‌سازه و اگه non-zero balance
 *   داشته باشن، به DB اضافه می‌کنه. default BTC برای deposit همون segwit
 *   می‌مونه.
 */
export async function importWallet(
  opts: ImportWalletOptions
): Promise<ImportWalletResult> {
  const {
    userId,
    mnemonic: raw,
    initialAddressCount = 1,
    scanLegacyBtc = true,
  } = opts;

  if (initialAddressCount < 1 || initialAddressCount > 100) {
    throw new Error('initialAddressCount باید بین 1 و 100 باشه');
  }

  const normalized = normalizeMnemonic(raw);
  const words = normalized.length === 0 ? 0 : normalized.split(' ').length;
  if (words !== 12 && words !== 24) {
    throw new InvalidMnemonicError('فقط mnemonic ۱۲ یا ۲۴ کلمه‌ای پشتیبانی می‌شه');
  }
  if (!isValidMnemonic(normalized)) {
    throw new InvalidMnemonicError('mnemonic نامعتبره (checksum یا wordlist)');
  }

  const created = await persistWallet(userId, normalized, words, initialAddressCount);

  if (!scanLegacyBtc) {
    return { ...created, legacyBtc: { scanned: 0, detected: [], skipped: true } };
  }

  const scanCount = Math.max(initialAddressCount, BTC_LEGACY_SCAN_MIN);
  const scanResult = await scanAndPersistLegacyBtc(created.walletId, normalized, scanCount);

  if (scanResult.detected.length > 0) {
    created.addresses.push(...scanResult.detected);
  }

  return { ...created, legacyBtc: scanResult };
}

/**
 * Legacy (m/44') و P2SH (m/49') BTC آدرس‌ها رو از index 0 تا count می‌سازه،
 * موجودی رو از mempool.space می‌گیره، و اون‌هایی که non-zero یا history
 * داشتن (tx_count > 0) رو به addresses جدول اضافه می‌کنه.
 *
 * best-effort: اگه mempool.space جواب نداد، scan رو skip می‌کنیم. ولت
 * segwit موجود دست‌نخورده می‌مونه.
 */
async function scanAndPersistLegacyBtc(
  walletId: number,
  mnemonic: string,
  count: number
): Promise<ImportWalletResult['legacyBtc']> {
  const all = await deriveBtcAllTypes(mnemonic, 0, count);
  const legacyAndP2sh = all.filter(
    (a) => a.btcAddressType === 'legacy' || a.btcAddressType === 'p2sh'
  );
  if (legacyAndP2sh.length === 0) {
    return { scanned: 0, detected: [] };
  }

  let balances;
  try {
    balances = await batchBtcBalances(legacyAndP2sh.map((a) => a.address));
  } catch (e) {
    console.error(`[wallet] legacy BTC scan failed for wallet=${walletId}:`, (e as Error).message);
    return { scanned: legacyAndP2sh.length, detected: [], skipped: true };
  }

  const byAddr = new Map(balances.map((b) => [b.address, b]));
  const detected = legacyAndP2sh.filter((a) => {
    const b = byAddr.get(a.address);
    // آدرسی که یا موجودی داره یا قبلاً تراکنش داشته رو نگه می‌داریم.
    return b && (b.sats > 0n || b.txCount > 0);
  });

  if (detected.length === 0) {
    return { scanned: legacyAndP2sh.length, detected: [] };
  }

  // persist detected addresses (batch INSERT)
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const a of detected) {
    const bal = byAddr.get(a.address)!;
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      walletId,
      a.chain,
      a.index,
      a.path,
      a.address,
      a.btcAddressType,
      bal.sats.toString(),
      bal.txCount
    );
  }
  await pool.query(
    `INSERT INTO addresses
       (wallet_id, chain, derivation_index, derivation_path, address, address_type,
        native_balance, tx_count)
     VALUES ${values.join(', ')}
     ON CONFLICT DO NOTHING`,
    params
  );

  return { scanned: legacyAndP2sh.length, detected };
}

async function persistWallet(
  userId: number,
  mnemonic: string,
  wordCount: 12 | 24,
  initialAddressCount: number
): Promise<CreateWalletResult> {
  const requests = ALL_CHAINS.map((c) => ({
    chain: c,
    fromIndex: 0,
    count: initialAddressCount,
  }));
  const addresses = await deriveMany(mnemonic, requests);
  const enc = encryptMnemonic(mnemonic);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletRes = await client.query<{ id: string }>(
      `INSERT INTO wallets
        (user_id, word_count, mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag,
         encryption_version, next_index_btc, next_index_eth, next_index_tron)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
       RETURNING id`,
      [userId, wordCount, enc.ciphertext, enc.nonce, enc.tag, enc.version, initialAddressCount]
    );
    const walletId = Number(walletRes.rows[0].id);

    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const a of addresses) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        walletId,
        a.chain,
        a.index,
        a.path,
        a.address,
        a.chain === 'BTC' ? (a.btcAddressType ?? 'segwit') : null
      );
    }
    await client.query(
      `INSERT INTO addresses
         (wallet_id, chain, derivation_index, derivation_path, address, address_type)
       VALUES ${values.join(', ')}`,
      params
    );

    await client.query('COMMIT');
    return { walletId, addresses };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

interface ReservedSlot {
  newIndex: number;
  enc: EncryptedMnemonic;
}

async function reserveNextIndex(walletId: number, chain: Chain): Promise<ReservedSlot> {
  const indexCol = `next_index_${chain.toLowerCase()}`;

  // tx کوتاه: increment + خوندن mnemonic. row-level lock فقط برای این یه statement.
  const res = await pool.query(
    `UPDATE wallets SET ${indexCol} = ${indexCol} + 1
     WHERE id = $1
     RETURNING ${indexCol} - 1 AS new_index,
               mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag, encryption_version`,
    [walletId]
  );

  if (res.rows.length === 0) throw new WalletNotFoundError(walletId);

  const row = res.rows[0];
  return {
    newIndex: Number(row.new_index),
    enc: {
      ciphertext: row.mnemonic_ciphertext,
      nonce: row.mnemonic_nonce,
      tag: row.mnemonic_tag,
      version: row.encryption_version,
    },
  };
}

async function lazyReEncrypt(
  walletId: number,
  enc: EncryptedMnemonic,
  plaintext: string
): Promise<void> {
  const updated = maybeReEncrypt(enc, plaintext);
  if (!updated) return;
  try {
    await pool.query(
      `UPDATE wallets
         SET mnemonic_ciphertext = $1,
             mnemonic_nonce = $2,
             mnemonic_tag = $3,
             encryption_version = $4
       WHERE id = $5 AND encryption_version = $6`,
      [
        updated.ciphertext,
        updated.nonce,
        updated.tag,
        updated.version,
        walletId,
        enc.version,
      ]
    );
  } catch (e) {
    // best-effort — صرفاً log کن، اپراتور بعداً می‌تونه دستی migrate کنه
    console.error(`[crypto] lazy re-encrypt wallet=${walletId} failed:`, (e as Error).message);
  }
}

export async function getNewDepositAddress(
  walletId: number,
  chain: Chain
): Promise<DerivedAddress> {
  const slot = await reserveNextIndex(walletId, chain);

  // خارج از tx: عملیات سنگین (decrypt + PBKDF2 + derive)
  const mnemonic = decryptMnemonic(slot.enc);
  const [derived] = await deriveMany(mnemonic, [
    { chain, fromIndex: slot.newIndex, count: 1 },
  ]);

  // INSERT خارج از tx (single statement، خودش atomic هست)
  await pool.query(
    `INSERT INTO addresses
       (wallet_id, chain, derivation_index, derivation_path, address, address_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      walletId,
      derived.chain,
      derived.index,
      derived.path,
      derived.address,
      derived.chain === 'BTC' ? (derived.btcAddressType ?? 'segwit') : null,
    ]
  );

  // lazy migration در پس‌زمینه — منتظر نمی‌مونیم
  void lazyReEncrypt(walletId, slot.enc, mnemonic);

  return derived;
}

export async function revealMnemonic(walletId: number): Promise<string> {
  const res = await pool.query(
    `SELECT mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag, encryption_version
     FROM wallets WHERE id = $1`,
    [walletId]
  );

  if (res.rows.length === 0) throw new WalletNotFoundError(walletId);

  const row = res.rows[0];
  const enc: EncryptedMnemonic = {
    ciphertext: row.mnemonic_ciphertext,
    nonce: row.mnemonic_nonce,
    tag: row.mnemonic_tag,
    version: row.encryption_version,
  };
  const plaintext = decryptMnemonic(enc);

  void lazyReEncrypt(walletId, enc, plaintext);

  return plaintext;
}
