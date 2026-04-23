/**
 * لایه cache + unified interface برای balance checker.
 *
 * Key format: balance:{chain}:{address}
 * TTL: دینامیک بر اساس priority (active: 60s, normal: 300s, inactive: 1800s)
 */

import { redis } from '../redis/client.js';
import { batchEthBalances } from './eth.js';
import { batchBtcBalances } from './btc.js';
import { batchTronBalances } from './tron.js';
import type { Chain } from '../wallet/derivation.js';

export interface CachedBalance {
  native: string;  // BigInt به صورت string (native unit: sats/wei/sun)
  usdt: string;    // BigInt به صورت string (فقط ETH و TRON؛ BTC نداره)
  checkedAt: number;
}

const TTL_BY_PRIORITY = {
  2: 60,     // active: 1 min
  1: 300,    // normal: 5 min
  0: 1800,   // inactive: 30 min
} as const;

function cacheKey(chain: Chain, address: string): string {
  return `balance:${chain}:${address}`;
}

export async function getCached(
  chain: Chain,
  address: string
): Promise<CachedBalance | null> {
  const raw = await redis.get(cacheKey(chain, address));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedBalance;
  } catch {
    return null;
  }
}

export async function setCached(
  chain: Chain,
  address: string,
  value: CachedBalance,
  priority: 0 | 1 | 2 = 1
): Promise<void> {
  const ttl = TTL_BY_PRIORITY[priority];
  await redis.setex(cacheKey(chain, address), ttl, JSON.stringify(value));
}

export async function invalidateCache(chain: Chain, address: string): Promise<void> {
  await redis.del(cacheKey(chain, address));
}

// ─── Unified batch fetcher ───
// گروه‌بندی بر اساس chain و فراخوانی موازی هر سه تا

export interface FetchedBalances {
  btc: Map<string, { sats: bigint; txCount: number }>;
  eth: Map<string, { eth: bigint; usdt: bigint }>;
  tron: Map<string, { trx: bigint; usdt: bigint }>;
}

export async function fetchBalancesByChain(
  btcAddresses: string[],
  ethAddresses: string[],
  tronAddresses: string[],
  opts: { forBenchmark?: boolean } = {}
): Promise<FetchedBalances> {
  const [btcResults, ethResults, tronResults] = await Promise.all([
    btcAddresses.length ? batchBtcBalances(btcAddresses) : Promise.resolve([]),
    ethAddresses.length
      ? batchEthBalances(ethAddresses, { forBenchmark: opts.forBenchmark })
      : Promise.resolve([]),
    tronAddresses.length ? batchTronBalances(tronAddresses) : Promise.resolve([]),
  ]);

  const btc = new Map<string, { sats: bigint; txCount: number }>();
  for (const r of btcResults) btc.set(r.address, { sats: r.sats, txCount: r.txCount });

  const eth = new Map<string, { eth: bigint; usdt: bigint }>();
  for (const r of ethResults) eth.set(r.address, { eth: r.eth, usdt: r.usdt });

  const tron = new Map<string, { trx: bigint; usdt: bigint }>();
  for (const r of tronResults) tron.set(r.address, { trx: r.trx, usdt: r.usdt });

  return { btc, eth, tron };
}
