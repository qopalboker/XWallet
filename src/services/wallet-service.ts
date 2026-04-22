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
  type Chain,
  type DerivedAddress,
} from '../wallet/derivation.js';
import {
  encryptMnemonic,
  decryptMnemonic,
  maybeReEncrypt,
  type EncryptedMnemonic,
} from '../crypto/aes.js';

const ALL_CHAINS: Chain[] = ['BTC', 'ETH', 'TRON'];

export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  readonly statusCode = 404;
  constructor(walletId: number) {
    super(`wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
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
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(walletId, a.chain, a.index, a.path, a.address);
    }
    await client.query(
      `INSERT INTO addresses (wallet_id, chain, derivation_index, derivation_path, address)
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
    `INSERT INTO addresses (wallet_id, chain, derivation_index, derivation_path, address)
     VALUES ($1, $2, $3, $4, $5)`,
    [walletId, derived.chain, derived.index, derived.path, derived.address]
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
