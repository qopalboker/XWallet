/**
 * BTC balance checker.
 *
 * دو provider:
 *   - 'esplora' (default): mempool.space یا هر Esplora-compatible (Electrs محلی).
 *     per-address request می‌فرسته، شامل mempool unconfirmed.
 *     Concurrency محدود (پیش‌فرض ۱۰) با inter-chunk delay کوتاه.
 *
 *   - 'blockchain_info': blockchain.info/multiaddr با تا ۱۰۰ آدرس در هر HTTP
 *     call. خروجی final_balance (confirmed) رو می‌گیره. برای throughput بالا
 *     خیلی بهتره ولی unconfirmed mempool رو لحاظ نمی‌کنه.
 *
 * env:
 *   BTC_BALANCE_PROVIDER     'esplora' (پیش‌فرض) | 'blockchain_info'
 *   BTC_ESPLORA_URL          base URL برای Esplora (پیش‌فرض mempool.space).
 *                            BTC_API هم برای backward compat قبول می‌شه.
 *   BTC_BLOCKCHAIN_INFO_URL  پیش‌فرض https://blockchain.info
 *   BTC_BALANCE_CONCURRENCY  پیش‌فرض ۱۰ (esplora). 1 برای blockchain_info کافیه
 *                            چون batched هست.
 *   BTC_INTERCHUNK_DELAY_MS  پیش‌فرض ۱۰۰ms بین chunkها (esplora فقط).
 *   BTC_BATCH_SIZE           اندازه دسته برای blockchain_info (پیش‌فرض ۱۰۰،
 *                            که سقف عملی API هست).
 */

// در docker-compose یه env unset به‌صورت "" پاس داده می‌شه؛ پس باید empty string
// رو هم به‌عنوان «ست‌نشده» تلقی کنیم. ?? فقط null/undefined رو filter می‌کنه.
const envOr = (name: string, fallback: string): string => {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
};

const ESPLORA_URL = envOr(
  'BTC_ESPLORA_URL',
  envOr('BTC_API', 'https://mempool.space/api')
);

const BLOCKCHAIN_INFO_URL = envOr('BTC_BLOCKCHAIN_INFO_URL', 'https://blockchain.info');

type Provider = 'esplora' | 'blockchain_info';

const PROVIDER: Provider =
  process.env.BTC_BALANCE_PROVIDER === 'blockchain_info'
    ? 'blockchain_info'
    : 'esplora';

const CONCURRENCY = (() => {
  const v = Number(process.env.BTC_BALANCE_CONCURRENCY);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
})();

const INTERCHUNK_DELAY_MS = (() => {
  const v = Number(process.env.BTC_INTERCHUNK_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 100;
})();

const BATCH_SIZE = (() => {
  const v = Number(process.env.BTC_BATCH_SIZE);
  return Number.isFinite(v) && v > 0 ? Math.min(100, Math.floor(v)) : 100;
})();

export interface BtcBalanceResult {
  address: string;
  sats: bigint;
  txCount: number;
}

/**
 * موجودی یک آدرس از Esplora (mempool.space یا Electrs محلی). شامل mempool.
 * این تابع همچنان export می‌شه چون legacy import scan ازش استفاده می‌کنه.
 */
export async function getBtcBalance(address: string): Promise<BtcBalanceResult> {
  const res = await fetch(`${ESPLORA_URL}/address/${address}`);
  if (!res.ok) throw new Error(`esplora ${res.status} for ${address}`);

  const d = (await res.json()) as {
    chain_stats: {
      funded_txo_sum: number;
      spent_txo_sum: number;
      tx_count: number;
    };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  };

  const sats = BigInt(
    d.chain_stats.funded_txo_sum -
      d.chain_stats.spent_txo_sum +
      d.mempool_stats.funded_txo_sum -
      d.mempool_stats.spent_txo_sum
  );

  return {
    address,
    sats,
    txCount: d.chain_stats.tx_count + d.mempool_stats.tx_count,
  };
}

async function batchBtcBalancesEsplora(
  addresses: string[],
  concurrency: number
): Promise<BtcBalanceResult[]> {
  const results: BtcBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += concurrency) {
    const chunk = addresses.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(getBtcBalance));

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error(`[btc] ${chunk[j]}: ${r.reason}`);
        results.push({ address: chunk[j], sats: 0n, txCount: 0 });
      }
    }

    if (INTERCHUNK_DELAY_MS > 0 && i + concurrency < addresses.length) {
      await new Promise((r) => setTimeout(r, INTERCHUNK_DELAY_MS));
    }
  }

  return results;
}

interface BlockchainInfoMultiaddrResponse {
  addresses?: Array<{
    address: string;
    n_tx?: number;
    final_balance?: number;
  }>;
}

async function multiaddrChunk(
  chunk: string[]
): Promise<Map<string, BtcBalanceResult>> {
  const url =
    `${BLOCKCHAIN_INFO_URL}/multiaddr?active=${encodeURIComponent(chunk.join('|'))}&n=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blockchain.info ${res.status}`);
  const data = (await res.json()) as BlockchainInfoMultiaddrResponse;
  const out = new Map<string, BtcBalanceResult>();
  for (const a of data.addresses ?? []) {
    out.set(a.address, {
      address: a.address,
      sats: BigInt(a.final_balance ?? 0),
      txCount: a.n_tx ?? 0,
    });
  }
  return out;
}

async function batchBtcBalancesBlockchainInfo(
  addresses: string[]
): Promise<BtcBalanceResult[]> {
  const results: BtcBalanceResult[] = [];
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const chunk = addresses.slice(i, i + BATCH_SIZE);
    let map: Map<string, BtcBalanceResult>;
    try {
      map = await multiaddrChunk(chunk);
    } catch (e) {
      console.error(
        `[btc] blockchain.info batch ${i}/${addresses.length} failed: ${(e as Error).message} — falling back to esplora`
      );
      // fallback به esplora فقط برای همین chunk
      const esp = await batchBtcBalancesEsplora(chunk, CONCURRENCY);
      results.push(...esp);
      continue;
    }
    for (const a of chunk) {
      const r = map.get(a);
      if (r) results.push(r);
      else results.push({ address: a, sats: 0n, txCount: 0 });
    }
    if (INTERCHUNK_DELAY_MS > 0 && i + BATCH_SIZE < addresses.length) {
      await new Promise((r) => setTimeout(r, INTERCHUNK_DELAY_MS));
    }
  }
  return results;
}

/**
 * موجودی چند آدرس BTC. provider بر اساس BTC_BALANCE_PROVIDER انتخاب می‌شه.
 *
 * @param addresses لیست آدرس‌ها
 * @param concurrency override برای esplora (پیش‌فرض از env). نادیده‌گرفته
 *                    می‌شه اگه provider = 'blockchain_info' باشه.
 */
export async function batchBtcBalances(
  addresses: string[],
  concurrency: number = CONCURRENCY
): Promise<BtcBalanceResult[]> {
  if (addresses.length === 0) return [];

  if (PROVIDER === 'blockchain_info') {
    return batchBtcBalancesBlockchainInfo(addresses);
  }
  return batchBtcBalancesEsplora(addresses, concurrency);
}
