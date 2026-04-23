/**
 * GetBlock.io integration.
 *
 * GetBlock یه Web3 RPC Provider هست که روی یه endpoint مشترک توکن
 * دسترسی رو تو URL جاسازی می‌کنه:
 *
 *   https://go.getblock.io/<ACCESS_TOKEN>/
 *   https://go.getblock.us/<ACCESS_TOKEN>/   (US region)
 *   https://go.getblock.asia/<ACCESS_TOKEN>/ (Asia region)
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
 * این ماژول:
 *   1. کانفیگ رو parse می‌کنه و flat list از توکن‌ها می‌ده
 *   2. URL نهایی رو می‌سازه (با رعایت region)
 *   3. یه JSON-RPC client ساده در اختیار می‌ذاره
 *
 * مرجع:
 *   https://docs.getblock.io/getting-started/authentication-with-access-tokens
 *   https://getblock.io/docs/guides/how-to-use-getblock-configuration-files/
 */

import { readFile } from 'node:fs/promises';

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

// ─── Config parsing ───

const REGION_BASES: Record<GetBlockRegion, string> = {
  io: 'https://go.getblock.io',
  us: 'https://go.getblock.us',
  asia: 'https://go.getblock.asia',
};

/**
 * Region مورد استفاده رو از env می‌خونه. پیش‌فرض 'io' (EU/Frankfurt).
 */
export function resolveRegion(): GetBlockRegion {
  const v = (process.env.GETBLOCK_REGION ?? 'io').toLowerCase();
  if (v === 'us' || v === 'asia' || v === 'io') return v;
  return 'io';
}

/**
 * URL نهایی endpoint برای یه توکن می‌سازه.
 *
 * مثال:
 *   buildEndpointUrl('abc123') → "https://go.getblock.io/abc123/"
 */
export function buildEndpointUrl(token: string, region: GetBlockRegion = resolveRegion()): string {
  if (!token || typeof token !== 'string') {
    throw new Error('GetBlock token نامعتبر است');
  }
  // ممیزی ساده: توکن نباید slash داشته باشه (جلوی URL-injection)
  if (/[\s/?#]/.test(token)) {
    throw new Error('GetBlock token شامل کاراکتر غیرمجاز است');
  }
  return `${REGION_BASES[region]}/${token}/`;
}

/**
 * فایل کانفیگ JSON رو parse می‌کنه و تمام توکن‌ها رو flat برمی‌گردونه.
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

// ─── JSON-RPC client ───

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
 * اگه endpoint با 429 جواب بده، کالر باید با توکن دیگه rotate کنه.
 * این تابع هیچ rotation ای نمی‌کنه — صرفاً یه fetch wrapper هست.
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
      const err = new Error(`GetBlock rate-limited (429)`) as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(
        `GetBlock HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`GetBlock RPC error ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === undefined) {
      throw new Error('GetBlock RPC: پاسخ بدون result');
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers for mapping GetBlock entries to our credential provider schema ───

/**
 * provider ای که تو api_credentials برای یه entry استفاده می‌شه.
 *
 *   eth jsonRpc  → 'eth_rpc'  (سازگار با ETH balance flow موجود)
 *   btc jsonRpc  → 'btc_rpc'  (provider جدید؛ موجب conflict با btc_api نمی‌شه)
 *
 * برای entry هایی که هیچ mapping ندارن، null می‌ده. caller باید skip کنه.
 */
export function providerForEntry(entry: GetBlockEntry): 'eth_rpc' | 'btc_rpc' | null {
  if (entry.rpcType !== 'jsonRpc') return null;
  if (entry.network !== 'mainnet') return null; // فعلاً فقط mainnet
  if (entry.chain === 'eth') return 'eth_rpc';
  if (entry.chain === 'btc') return 'btc_rpc';
  return null;
}

/**
 * مقدار value ای که تو DB ذخیره می‌شه. برای eth همون URL کامل هست تا با
 * JsonRpcProvider ethers مستقیم کار کنه. برای btc هم URL کامل ذخیره می‌کنیم
 * تا اگه بعداً JSON-RPC BTC خواستیم استفاده کنیم، آماده باشه.
 */
export function valueForEntry(entry: GetBlockEntry, region: GetBlockRegion = resolveRegion()): string {
  return buildEndpointUrl(entry.token, region);
}

/**
 * Label پیش‌فرض برای UI/DB (قابل override توسط کالر).
 */
export function defaultLabel(entry: GetBlockEntry): string {
  return `GetBlock ${entry.chain}-${entry.network}`;
}
