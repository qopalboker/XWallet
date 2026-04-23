/**
 * GetBlock.io integration.
 *
 * GetBlock یه Web3 RPC Provider هست که روی یه endpoint مشترک توکن
 * دسترسی رو تو URL جاسازی می‌کنه:
 *
 *   https://go.getblock.io/<ACCESS_TOKEN>/    (EU — پیش‌فرض)
 *   https://go.getblock.us/<ACCESS_TOKEN>/    (US)
 *   https://go.getblock.asia/<ACCESS_TOKEN>/  (Asia)
 *
 * هر توکن روی یه (chain, network, rpc_type) بسته می‌شه. تو کانفیگی که
 * GetBlock می‌ده (shared configuration file) شکل این‌طوریه:
 *
 *   {
 *     "shared": {
 *       "btc": { "mainnet": { "jsonRpc": ["<token>"] } },
 *       "eth": { "mainnet": { "jsonRpc": ["<token>"] } }
 *     }
 *   }
 *
 * مرجع:
 *   https://docs.getblock.io/getting-started/authentication-with-access-tokens
 *   https://getblock.io/docs/guides/how-to-use-getblock-configuration-files/
 *
 * ─── TODO(getblock-btc) ────────────────────────────────────────────────
 * فعلاً BTC entries رد می‌شن (ن zap در balance flow بر پایهٔ mempool.space
 * هست، و هیچ broadcast flow ای که نیاز به sendrawtransaction داشته باشه
 * نداریم). وقتی broadcast اضافه شد، provider='btc_rpc' رو برگردون و
 * sendrawtransaction/gettxout رو به این ماژول وصل کن. balance lookup
 * by-address همچنان باید روی mempool.space بمونه (BTC Core RPC بدون
 * -addressindex امکان لیست‌گرفتن بالانس یه آدرس رو نداره).
 * ────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'node:fs/promises';
import {
  addCredential,
  invalidateCache,
  listCredentials,
  markError,
  markRateLimited,
  setActive,
  type Provider,
} from './credentials-service.js';

// ─── Types ───

export type GetBlockRegion = 'io' | 'us' | 'asia';

export type GetBlockRpcType = 'jsonRpc' | 'rest' | 'webSocket';

/**
 * شکل فایل کانفیگی که GetBlock می‌ده. فقط بخشی که واقعاً استفاده می‌کنیم.
 * chain‌ها و شبکه‌های ناشناخته رو بی‌صدا نادیده می‌گیریم (forwards-compat).
 */
export interface GetBlockConfigFile {
  shared?: Record<string, Record<string, Partial<Record<GetBlockRpcType, string[]>>>>;
  // dedicated nodes هم همین شکل رو دارن ولی ما فعلاً فقط shared رو پشتیبانی می‌کنیم.
  dedicated?: Record<string, Record<string, Partial<Record<GetBlockRpcType, string[]>>>>;
}

export interface GetBlockEntry {
  chain: string;             // "btc" | "eth" | "bnb" | ...
  network: string;           // "mainnet" | "testnet" | ...
  rpcType: GetBlockRpcType;
  token: string;
}

// ─── Token validation ───────────────────────────────────────────────────

/**
 * شکل Access Token های GetBlock: ۳۲ کاراکتر hex (lower یا upper).
 * مرجع: نمونه‌های docs + کانفیگ shared که کاربر می‌ده (e.g.
 * "499ae68ced964da691b52dbbc40a65b9") دقیقاً ۳۲ hex char هست.
 */
const GETBLOCK_TOKEN_RE = /^[a-f0-9]{32}$/i;

export function isValidGetBlockToken(token: unknown): boolean {
  return typeof token === 'string' && GETBLOCK_TOKEN_RE.test(token);
}

// ─── URL redaction (ایمنی لاگ) ──────────────────────────────────────────

/**
 * توکن GetBlock رو تو یه URL با … می‌پوشونه که لاگ‌ها leak نکنن.
 *   قبل: https://go.getblock.io/499ae68ced964da691b52dbbc40a65b9/
 *   بعد:  https://go.getblock.io/499ae68c…/
 */
export function redactGetBlockUrl(url: string): string {
  if (typeof url !== 'string') return url;
  return url.replace(
    /(https:\/\/[a-z]+\.getblock\.(?:io|us|asia)\/)([a-f0-9]{8})[a-f0-9]{24}(\/?)/gi,
    '$1$2…$3'
  );
}

// ─── Region ─────────────────────────────────────────────────────────────

const REGION_BASES: Record<GetBlockRegion, string> = {
  io: 'https://go.getblock.io',
  us: 'https://go.getblock.us',
  asia: 'https://go.getblock.asia',
};

/**
 * region فعلی runtime. پیش‌فرض `null` یعنی هنوز boot check نشده و
 * `resolveRegion()` باید از env بخونه. وقتی `verifyRegionOnBoot` اجرا
 * می‌شه، اگه region کاربر unreachable بود این var رو به 'io' ست می‌کنه
 * تا `buildEndpointUrl` واقعاً از fallback استفاده کنه.
 *
 * موقع recheck دوره‌ای هم همین مقدار به‌روز می‌شه.
 */
let activeRegion: GetBlockRegion | null = null;

/**
 * Region مورد استفاده. اولویت:
 *   1. `activeRegion` (اگه boot/recheck یه تصمیم واقعی گرفته)
 *   2. env `GETBLOCK_REGION`
 *   3. 'io'
 */
export function resolveRegion(): GetBlockRegion {
  if (activeRegion) return activeRegion;
  const v = (process.env.GETBLOCK_REGION ?? 'io').toLowerCase();
  if (v === 'us' || v === 'asia' || v === 'io') return v;
  return 'io';
}

/** فقط برای تست: activeRegion رو reset می‌کنه. */
export function __resetActiveRegionForTests(): void {
  activeRegion = null;
}

/**
 * Reachability check برای یه region. endpoint base رو با HEAD می‌زنیم؛
 * هر جواب HTTP (حتی 403) یعنی host resolve و TLS OK — فقط NXDOMAIN
 * یا timeout بد تلقی می‌شه.
 */
export async function isRegionReachable(region: GetBlockRegion, timeoutMs = 5_000): Promise<boolean> {
  const base = REGION_BASES[region];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/`, { method: 'GET', signal: controller.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type RegionLogger = { info: (m: string) => void; warn: (m: string) => void };

async function evaluateRegion(logger: RegionLogger): Promise<GetBlockRegion> {
  // جدا از activeRegion تصمیم می‌گیریم تا recheck بتونه به region ترجیحی
  // برگرده وقتی شبکه دوباره وصل شد.
  const preferred = ((): GetBlockRegion => {
    const v = (process.env.GETBLOCK_REGION ?? 'io').toLowerCase();
    return v === 'us' || v === 'asia' || v === 'io' ? v : 'io';
  })();

  if (await isRegionReachable(preferred)) {
    logger.info(`[getblock] region '${preferred}' reachable (${REGION_BASES[preferred]})`);
    return preferred;
  }
  if (preferred !== 'io' && (await isRegionReachable('io'))) {
    logger.warn(`[getblock] region '${preferred}' unreachable — using 'io'`);
    return 'io';
  }
  logger.warn(`[getblock] no region reachable — keeping '${preferred}' (will retry)`);
  return preferred;
}

/**
 * تو startup فراخوانی می‌شه. Region کانفیگ‌شده رو چک می‌کنه؛ اگه
 * unreachable بود، runtime به 'io' fallback می‌کنه.
 *
 * در صورت تنظیم `recheckIntervalMs` (پیش‌فرض ۱۰ دقیقه)، یه interval
 * راه می‌اندازه که دوره‌ای `activeRegion` رو به‌روز کنه. این مهمه
 * برای شبکه‌های بی‌ثبات — اگه شبکه برگشت و region ترجیحی دوباره
 * reachable شد، بدون restart به‌کار می‌افته.
 */
export async function verifyRegionOnBoot(
  logger?: RegionLogger,
  opts: { recheckIntervalMs?: number | null } = {}
): Promise<GetBlockRegion> {
  const log = logger ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  activeRegion = await evaluateRegion(log);

  const interval = opts.recheckIntervalMs ?? 10 * 60 * 1000;
  if (interval && interval > 0) {
    const t = setInterval(() => {
      evaluateRegion(log)
        .then((r) => {
          if (r !== activeRegion) {
            log.info(`[getblock] region switched: ${activeRegion} → ${r}`);
            activeRegion = r;
          }
        })
        .catch((e) => log.warn(`[getblock] region recheck failed: ${(e as Error).message}`));
    }, interval);
    // داخلی Node: اگه interval فقط کار در پس‌زمینه بکنه، باعث نشه process
    // از shutdown جلوگیری کنه.
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  }

  return activeRegion;
}

// ─── URL builder ────────────────────────────────────────────────────────

/**
 * URL نهایی endpoint برای یه توکن می‌سازه.
 */
export function buildEndpointUrl(token: string, region: GetBlockRegion = resolveRegion()): string {
  if (!isValidGetBlockToken(token)) {
    throw new Error('GetBlock token نامعتبر است (باید ۳۲ کاراکتر hex باشد)');
  }
  return `${REGION_BASES[region]}/${token}/`;
}

// ─── Config parsing ─────────────────────────────────────────────────────

/**
 * فایل کانفیگ JSON رو parse می‌کنه و تمام توکن‌ها رو flat برمی‌گردونه.
 * validation اینجا انجام نمی‌شه — فقط ساختار؛ توکن‌های نامعتبر تو
 * import step detect می‌شن.
 */
export function parseConfig(raw: string | object): GetBlockEntry[] {
  const cfg: GetBlockConfigFile =
    typeof raw === 'string' ? (JSON.parse(raw) as GetBlockConfigFile) : (raw as GetBlockConfigFile);

  const out: GetBlockEntry[] = [];
  for (const bucket of ['shared', 'dedicated'] as const) {
    const section = cfg[bucket];
    if (!section) continue;
    for (const [chain, networks] of Object.entries(section)) {
      for (const [network, types] of Object.entries(networks)) {
        for (const [rpcType, tokens] of Object.entries(types)) {
          if (!Array.isArray(tokens)) continue;
          for (const token of tokens) {
            if (typeof token !== 'string' || !token) continue;
            out.push({
              chain: chain.toLowerCase(),
              network: network.toLowerCase(),
              rpcType: rpcType as GetBlockRpcType,
              token,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * کانفیگ رو از مسیر فایل یا از env می‌خونه.
 * ترتیب اولویت:
 *   1. آرگومان filePath
 *   2. process.env.GETBLOCK_CONFIG_PATH
 *   3. process.env.GETBLOCK_CONFIG_JSON (inline JSON)
 */
export async function loadConfig(filePath?: string): Promise<GetBlockEntry[]> {
  const path = filePath ?? process.env.GETBLOCK_CONFIG_PATH;
  if (path) {
    const raw = await readFile(path, 'utf8');
    return parseConfig(raw);
  }
  const inline = process.env.GETBLOCK_CONFIG_JSON;
  if (inline) return parseConfig(inline);
  return [];
}

// ─── Entry → credential mapping ─────────────────────────────────────────

/**
 * eth jsonRpc → 'eth_rpc' (تو balance rotation موجود استفاده می‌شه)
 * btc / سایر → null (هیچ consumer ای ندارن — رجوع به TODO بالا)
 */
export function providerForEntry(entry: GetBlockEntry): Provider | null {
  if (entry.rpcType !== 'jsonRpc') return null;
  if (entry.network !== 'mainnet') return null;
  if (entry.chain === 'eth') return 'eth_rpc';
  return null;
}

export function defaultLabel(entry: GetBlockEntry): string {
  return `GetBlock ${entry.chain}-${entry.network}`;
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class GetBlockThrottled extends Error {
  constructor(message = 'GetBlock rate-limited (429)') {
    super(message);
    this.name = 'GetBlockThrottled';
  }
}

export class GetBlockAuthError extends Error {
  constructor(status: number, message?: string) {
    super(message ?? `GetBlock auth failed (${status})`);
    this.name = 'GetBlockAuthError';
  }
}

// ─── JSON-RPC client ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: unknown[] | Record<string, any>;
  id?: number | string;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * یه JSON-RPC call ساده به GetBlock می‌زنه.
 *
 * Caller باید GetBlockThrottled و GetBlockAuthError رو catch کنه و طبق
 * policy (markRateLimited / setActive=false) به credentials-service خبر
 * بده. این تابع خودش side-effect رو DB نداره — صرفاً fetch+classify.
 */
export async function jsonRpcCall<T = unknown>(
  endpointUrl: string,
  req: JsonRpcRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const { timeoutMs = 15_000, signal } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const safeUrl = redactGetBlockUrl(endpointUrl);

  try {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: req.id ?? 'xwallet',
        method: req.method,
        params: req.params ?? [],
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw new GetBlockThrottled(`GetBlock rate-limited (429) on ${safeUrl}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GetBlockAuthError(res.status, `GetBlock auth failed ${res.status} on ${safeUrl}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `GetBlock HTTP ${res.status} on ${safeUrl}${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }

    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(
        `GetBlock RPC error ${body.error.code} on ${safeUrl}: ${body.error.message}`
      );
    }
    if (body.result === undefined) {
      throw new Error(`GetBlock RPC: پاسخ بدون result (${safeUrl})`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrapper خودکار که credential رو از DB rotate می‌کنه و خطاهای 429/401/403
 * رو به مارکرهای credentials-service ترجمه می‌کنه. Balance checker ها
 * می‌تونن مستقیم ازش استفاده کنن.
 *
 * NOTE: کالر باید pickCredential('eth_rpc') خودش بزنه اگه می‌خواد کنترل
 * دقیق داشته باشه. این متد یه ابزار کمکی هست.
 */
export async function classifyAndMark(
  credId: number,
  err: unknown,
  cooldownSeconds = 60
): Promise<'throttled' | 'auth_failed' | 'error' | 'unknown'> {
  if (err instanceof GetBlockThrottled) {
    await markRateLimited(credId, cooldownSeconds);
    return 'throttled';
  }
  if (err instanceof GetBlockAuthError) {
    await setActive(credId, false);
    await markError(credId, err.message);
    return 'auth_failed';
  }
  if (err instanceof Error) {
    await markError(credId, err.message);
    return 'error';
  }
  return 'unknown';
}

// ─── Import (shared by CLI and admin route) ─────────────────────────────

export interface ImportResult {
  added: number;
  skipped: number;         // تکراری یا unsupported (مثل btc فعلاً)
  invalid: string[];       // آرایه پیام خطا برای توکن‌های نامعتبر
  skippedBtc: number;      // جداگانه برای clarity
}

export interface ImportOptions {
  adminId: number;
  skipExisting?: boolean;
  /** فقط برای تست: لاگر مصنوعی */
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * هستهٔ import. هم CLI script و هم admin route باید از این فانکشن
 * استفاده کنن تا رفتار یکسان بمونه.
 *
 * Idempotency: بر پایهٔ ترکیب (provider, label) — اگه `skipExisting=true`
 * ردیف‌های با همون label رد می‌شن.
 *
 * توکن‌های نامعتبر (non-hex یا طول اشتباه) به `result.invalid` اضافه
 * می‌شن ولی import بقیه ادامه پیدا می‌کنه.
 */
export async function importGetBlockConfig(
  rawConfig: string | object,
  opts: ImportOptions
): Promise<ImportResult> {
  const log = opts.logger ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const entries = parseConfig(rawConfig);

  const result: ImportResult = { added: 0, skipped: 0, invalid: [], skippedBtc: 0 };

  // set از label های موجود برای idempotency (فقط provider های مرتبط)
  const existingLabels = new Set<string>();
  if (opts.skipExisting !== false) {
    const existing = await listCredentials('eth_rpc');
    for (const it of existing) {
      if (it.label) existingLabels.add(`eth_rpc|${it.label}`);
    }
  }

  // BTC‌ها رو جداگانه بشمار تا لاگ واضح باشه (نه صرفاً skip کلی)
  const btcCount = entries.filter((e) => e.chain === 'btc').length;
  if (btcCount > 0) {
    log.info(
      `[getblock-import] Skipping ${btcCount} BTC token(s): GetBlock BTC is not wired ` +
      `to any flow yet. Re-enable when broadcast is added.`
    );
    result.skippedBtc = btcCount;
    result.skipped += btcCount;
  }

  for (const entry of entries) {
    if (entry.chain === 'btc') continue; // لاگ بالا انجام شد

    // validation اول از همه
    if (!isValidGetBlockToken(entry.token)) {
      result.invalid.push(
        `${entry.chain}/${entry.network}: ${entry.token.slice(0, 6)}… (expected 32 hex chars)`
      );
      continue;
    }

    const provider = providerForEntry(entry);
    if (!provider) {
      // chain/network/rpcType unsupported
      result.skipped++;
      log.info(
        `[getblock-import] unsupported entry ${entry.chain}/${entry.network}/${entry.rpcType} — skip`
      );
      continue;
    }

    const label = defaultLabel(entry);
    const dedupKey = `${provider}|${label}`;
    if (existingLabels.has(dedupKey)) {
      result.skipped++;
      continue;
    }

    const value = buildEndpointUrl(entry.token);
    await addCredential({
      provider,
      value,
      label,
      adminId: opts.adminId,
      // GetBlock free tier = 50k CU/day. یه benchmark run می‌تونه کل این
      // سهمیه رو بخوره و traffic واقعی تا فردا بیکار بشه. پس پیش‌فرض false.
      benchmarkAllowed: false,
    });
    existingLabels.add(dedupKey);
    result.added++;
  }

  invalidateCache('eth_rpc');
  return result;
}
