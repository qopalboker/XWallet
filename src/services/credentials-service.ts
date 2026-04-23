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
  benchmarkAllowed: boolean;
  createdAt: Date;
}

/**
 * خطای اختصاصی وقتی برای provider (و شاید filter) هیچ credential آزاد
 * و قابل استفاده ای وجود نداشته باشه. Caller می‌تونه این رو تشخیص بده
 * و به‌جای retry کردن همون اشتباه بی‌نهایت، سریع fail کنه.
 */
export class NoAvailableCredential extends Error {
  constructor(provider: Provider, reason?: string) {
    super(
      `هیچ credential فعال برای '${provider}' در دسترس نیست${reason ? ` (${reason})` : ''}`
    );
    this.name = 'NoAvailableCredential';
  }
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
            is_active, benchmark_allowed, created_at
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
      benchmarkAllowed: r.benchmark_allowed !== false,
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

export interface PickOptions {
  /**
   * اگه true، فقط credential هایی که `benchmark_allowed=true` دارن
   * برگردونده می‌شن. این جلوی خوردن سهمیهٔ GetBlock (۵۰k CU/روز) رو
   * توسط benchmark می‌گیره.
   */
  forBenchmark?: boolean;
  /**
   * credential ID هایی که این request توی retry loop قبلاً امتحان کرده.
   * pickCredential از برگردوندن این‌ها صرف‌نظر می‌کنه (تا رو credential
   * بعدی جابه‌جا بشه).
   */
  excludeIds?: ReadonlySet<number> | Iterable<number>;
}

/**
 * یه credential آزاد برای provider برمی‌گردونه (round-robin).
 *
 * آزاد = is_active=true AND (rate_limited_until IS NULL OR < now)
 *        AND (forBenchmark ⇒ benchmark_allowed=true)
 *        AND (id ∉ excludeIds)
 *
 * اگه هیچ credential‌ای نباشه، null برمی‌گردونه.
 */
export async function pickCredential(
  provider: Provider,
  opts: PickOptions = {}
): Promise<CredentialRow | null> {
  const c = await getProviderCache(provider);
  if (c.items.length === 0) return null;

  const excludeSet =
    opts.excludeIds instanceof Set
      ? (opts.excludeIds as Set<number>)
      : opts.excludeIds
        ? new Set<number>(opts.excludeIds as Iterable<number>)
        : null;

  const now = Date.now();
  const matches = (cred: CredentialRow): boolean => {
    if (excludeSet?.has(cred.id)) return false;
    if (opts.forBenchmark && !cred.benchmarkAllowed) return false;
    const blocked = cred.rateLimitedUntil && cred.rateLimitedUntil.getTime() > now;
    if (blocked) return false;
    return true;
  };

  for (let i = 0; i < c.items.length; i++) {
    const idx = (c.cursor + i) % c.items.length;
    const cred = c.items[idx];
    if (matches(cred)) {
      c.cursor = (idx + 1) % c.items.length;
      return cred;
    }
  }
  return null;
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

/**
 * 401/403 از endpoint = توکن اشتباه یا غیرفعال شده. Credential رو
 * deactivate می‌کنیم تا تا وقتی ادمین دستی بررسی نکرده، rotation
 * دوباره سراغش نره.
 */
export async function markAuthFailed(credId: number, message = 'auth_failed'): Promise<void> {
  await pool.query(
    `UPDATE api_credentials
     SET is_active = false,
         failure_count = failure_count + 1,
         last_error_at = NOW(),
         last_error_message = $2
     WHERE id = $1`,
    [credId, message.slice(0, 500)]
  );
  invalidateCache();
  console.warn(`[creds] id=${credId} deactivated after auth failure`);
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
            is_active, benchmark_allowed, created_at
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
      benchmarkAllowed: r.benchmark_allowed !== false,
      createdAt: r.created_at,
    };
  });
}

export async function addCredential(opts: {
  provider: Provider;
  value: string;
  label?: string;
  adminId: number;
  /** پیش‌فرض true. importer GetBlock به false ست می‌کنه تا سهمیهٔ free-tier رو
   *  یه benchmark run کامل نخوره. */
  benchmarkAllowed?: boolean;
}): Promise<number> {
  const enc = encryptMnemonic(opts.value);
  const res = await pool.query<{ id: number }>(
    `INSERT INTO api_credentials
     (provider, label, value_ciphertext, value_nonce, value_tag, encryption_version,
      benchmark_allowed, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      opts.provider,
      opts.label ?? null,
      enc.ciphertext,
      enc.nonce,
      enc.tag,
      enc.version,
      opts.benchmarkAllowed ?? true,
      opts.adminId,
    ]
  );
  invalidateCache(opts.provider);
  return res.rows[0].id;
}

/** toggle کردن benchmark_allowed روی یه credential موجود */
export async function setBenchmarkAllowed(id: number, allowed: boolean): Promise<void> {
  await pool.query(
    `UPDATE api_credentials SET benchmark_allowed = $1 WHERE id = $2`,
    [allowed, id]
  );
  invalidateCache();
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
