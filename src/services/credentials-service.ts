/**
 * Credentials store for API keys / RPC endpoints.
 *
 *   - توکن‌ها با AES-256-GCM (همون keyring) encrypt می‌شن
 *   - در memory cache (TTL = 5s)
 *   - Round-robin rotation با skip موقت در صورت rate-limit
 *   - Lazy key migration: اگه ردیف version قدیمی داره، در پس‌زمینه re-encrypt
 *   - Admin از پنل CRUD می‌کنه
 */

import { pool } from '../db/pool.js';
import {
  encryptMnemonic,
  decryptMnemonic,
  maybeReEncrypt,
  type EncryptedMnemonic,
} from '../crypto/aes.js';

export type Provider = 'trongrid' | 'eth_rpc' | 'btc_api';

export interface CredentialRow {
  id: number;
  provider: Provider;
  label: string | null;
  value: string;
  lastUsedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  rateLimitedUntil: Date | null;
  successCount: number;
  failureCount: number;
  isActive: boolean;
  createdAt: Date;
}

// ─── Cache ───
// TTL کوتاه (۵ ثانیه): اگه ادمین credential رو غیرفعال کنه یا rotate،
// بعد از حداکثر ۵ ثانیه worker متوقف می‌شه استفاده‌اش. CRUD endpoint ها
// خودشون invalidateCache صدا می‌زنن برای اعمال فوری توی همین process.
const CACHE_TTL_MS = 5_000;
const cache: {
  [P in Provider]?: { loadedAt: number; items: CredentialRow[]; cursor: number };
} = {};

function rowToEnc(r: {
  value_ciphertext: Buffer;
  value_nonce: Buffer;
  value_tag: Buffer;
  encryption_version: number;
}): EncryptedMnemonic {
  return {
    ciphertext: r.value_ciphertext,
    nonce: r.value_nonce,
    tag: r.value_tag,
    version: r.encryption_version,
  };
}

async function lazyReEncryptCredential(
  id: number,
  enc: EncryptedMnemonic,
  plaintext: string
): Promise<void> {
  const updated = maybeReEncrypt(enc, plaintext);
  if (!updated) return;
  try {
    await pool.query(
      `UPDATE api_credentials
         SET value_ciphertext = $1,
             value_nonce = $2,
             value_tag = $3,
             encryption_version = $4
       WHERE id = $5 AND encryption_version = $6`,
      [updated.ciphertext, updated.nonce, updated.tag, updated.version, id, enc.version]
    );
  } catch (e) {
    console.error(`[crypto] lazy re-encrypt cred=${id} failed:`, (e as Error).message);
  }
}

async function loadProvider(provider: Provider): Promise<CredentialRow[]> {
  const res = await pool.query(
    `SELECT id, provider, label,
            value_ciphertext, value_nonce, value_tag, encryption_version,
            last_used_at, last_error_at, last_error_message,
            rate_limited_until, success_count, failure_count,
            is_active, created_at
     FROM api_credentials
     WHERE provider = $1 AND is_active = true
     ORDER BY id ASC`,
    [provider]
  );

  return res.rows.map((r) => {
    const enc = rowToEnc(r);
    const value = decryptMnemonic(enc);
    void lazyReEncryptCredential(r.id, enc, value);
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      value,
      lastUsedAt: r.last_used_at,
      lastErrorAt: r.last_error_at,
      lastErrorMessage: r.last_error_message,
      rateLimitedUntil: r.rate_limited_until,
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
      isActive: r.is_active,
      createdAt: r.created_at,
    };
  });
}

async function getProviderCache(provider: Provider): Promise<{ items: CredentialRow[]; cursor: number }> {
  const entry = cache[provider];
  if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) return entry;

  const items = await loadProvider(provider);
  const newEntry = { loadedAt: Date.now(), items, cursor: entry?.cursor ?? 0 };
  cache[provider] = newEntry;
  return newEntry;
}

export function invalidateCache(provider?: Provider): void {
  if (provider) delete cache[provider];
  else Object.keys(cache).forEach((k) => delete cache[k as Provider]);
}

// ─── Rotation ───

/**
 * یه credential آزاد برای provider برمی‌گردونه (round-robin).
 * آزاد = is_active=true و rate_limited_until < now.
 * اگه هیچ credential‌ای نباشه، null برمی‌گردونه.
 */
export async function pickCredential(provider: Provider): Promise<CredentialRow | null> {
  const c = await getProviderCache(provider);
  if (c.items.length === 0) return null;

  const now = Date.now();

  for (let i = 0; i < c.items.length; i++) {
    const idx = (c.cursor + i) % c.items.length;
    const cred = c.items[idx];
    const blocked = cred.rateLimitedUntil && cred.rateLimitedUntil.getTime() > now;
    if (!blocked) {
      c.cursor = (idx + 1) % c.items.length;
      return cred;
    }
  }

  // همه blocked — اونی که زودتر آزاد می‌شه
  let best = c.items[0];
  for (const item of c.items) {
    if (!best.rateLimitedUntil) break;
    if (item.rateLimitedUntil && item.rateLimitedUntil < best.rateLimitedUntil) best = item;
  }
  return best;
}

// ─── Feedback ───

export async function markSuccess(credId: number): Promise<void> {
  await pool.query(
    `UPDATE api_credentials
     SET success_count = success_count + 1, last_used_at = NOW()
     WHERE id = $1`,
    [credId]
  );
}

export async function markRateLimited(credId: number, seconds = 60): Promise<void> {
  await pool.query(
    `UPDATE api_credentials
     SET failure_count = failure_count + 1,
         rate_limited_until = NOW() + ($2 || ' seconds')::interval,
         last_error_at = NOW(),
         last_error_message = 'rate_limited (429)'
     WHERE id = $1`,
    [credId, seconds.toString()]
  );
  invalidateCache();
  console.warn(`[creds] id=${credId} rate-limited for ${seconds}s`);
}

export async function markError(credId: number, message: string): Promise<void> {
  await pool.query(
    `UPDATE api_credentials
     SET failure_count = failure_count + 1,
         last_error_at = NOW(),
         last_error_message = $2
     WHERE id = $1`,
    [credId, message.slice(0, 500)]
  );
}

// ─── CRUD ───

export async function listCredentials(
  provider?: Provider
): Promise<Array<Omit<CredentialRow, 'value'> & { valuePreview: string }>> {
  const params: unknown[] = [];
  let where = '';
  if (provider) {
    params.push(provider);
    where = `WHERE provider = $1`;
  }

  const res = await pool.query(
    `SELECT id, provider, label,
            value_ciphertext, value_nonce, value_tag, encryption_version,
            last_used_at, last_error_at, last_error_message,
            rate_limited_until, success_count, failure_count,
            is_active, created_at
     FROM api_credentials ${where}
     ORDER BY provider, id`,
    params
  );

  return res.rows.map((r) => {
    const value = decryptMnemonic(rowToEnc(r));
    const preview = value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : '***';
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      valuePreview: preview,
      lastUsedAt: r.last_used_at,
      lastErrorAt: r.last_error_at,
      lastErrorMessage: r.last_error_message,
      rateLimitedUntil: r.rate_limited_until,
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
      isActive: r.is_active,
      createdAt: r.created_at,
    };
  });
}

export async function addCredential(opts: {
  provider: Provider;
  value: string;
  label?: string;
  adminId: number;
}): Promise<number> {
  const enc = encryptMnemonic(opts.value);
  const res = await pool.query<{ id: number }>(
    `INSERT INTO api_credentials
     (provider, label, value_ciphertext, value_nonce, value_tag, encryption_version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      opts.provider,
      opts.label ?? null,
      enc.ciphertext,
      enc.nonce,
      enc.tag,
      enc.version,
      opts.adminId,
    ]
  );
  invalidateCache(opts.provider);
  return res.rows[0].id;
}

export async function deleteCredential(id: number): Promise<void> {
  await pool.query(`DELETE FROM api_credentials WHERE id = $1`, [id]);
  invalidateCache();
}

export async function setActive(id: number, active: boolean): Promise<void> {
  await pool.query(`UPDATE api_credentials SET is_active = $1 WHERE id = $2`, [active, id]);
  invalidateCache();
}

/**
 * آزاد کردن دستی rate limit block.
 */
export async function clearRateLimit(id: number): Promise<void> {
  await pool.query(
    `UPDATE api_credentials SET rate_limited_until = NULL WHERE id = $1`,
    [id]
  );
  invalidateCache();
}
