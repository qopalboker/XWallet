/**
 * TRON + USDT-TRC20 balance checker.
 *
 * Uses the full-node `/wallet/*` HTTP API (no API key required).
 * Each address triggers two requests in parallel:
 *   - POST /wallet/getaccount             → TRX balance (sun units)
 *   - POST /wallet/triggerconstantcontract → USDT-TRC20 balance via balanceOf(address)
 */

import bs58check from 'bs58check';

const TRON_API = process.env.TRON_API ?? 'https://api.tronstack.io';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const REQUEST_TIMEOUT_MS = 5000;

export interface TronBalanceResult {
  address: string;
  trx: bigint;   // sun (1 TRX = 1e6 sun)
  usdt: bigint;  // smallest USDT unit (1 USDT = 1e6)
}

/**
 * Tron base58 → ABI-encoded address parameter for triggerconstantcontract.
 * The 21-byte payload is [0x41, ...20 address bytes]; the EVM ABI form drops
 * the 0x41 prefix and left-pads the remaining 20 bytes to 32 bytes.
 */
export function addressToParam(base58: string): string {
  const decoded = bs58check.decode(base58);
  if (decoded.length !== 21 || decoded[0] !== 0x41) {
    throw new Error(`invalid tron address: ${base58}`);
  }
  const hex = Buffer.from(decoded.slice(1)).toString('hex');
  return hex.padStart(64, '0');
}

async function postJson(host: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`tron ${path} ${res.status}`);
  }
  return res.json();
}

async function fetchTrx(host: string, address: string): Promise<bigint> {
  const data = await postJson(host, '/wallet/getaccount', { address, visible: true });
  return BigInt(data.balance ?? 0);
}

async function fetchUsdt(host: string, address: string): Promise<bigint> {
  const data = await postJson(host, '/wallet/triggerconstantcontract', {
    owner_address: address,
    contract_address: USDT_TRC20,
    function_selector: 'balanceOf(address)',
    parameter: addressToParam(address),
    visible: true,
  });
  if (data.result?.result !== true) {
    throw new Error(`tron contract call failed: ${data.result?.message ?? 'unknown'}`);
  }
  const hex = data.constant_result?.[0];
  if (typeof hex !== 'string') {
    throw new Error('tron: missing constant_result');
  }
  return BigInt('0x' + hex);
}

export async function getTronBalance(address: string): Promise<TronBalanceResult> {
  const [trx, usdt] = await Promise.all([
    fetchTrx(TRON_API, address),
    fetchUsdt(TRON_API, address),
  ]);
  console.debug(`[tron] ${address} via ${TRON_API}`);
  return { address, trx, usdt };
}

export async function batchTronBalances(
  addresses: string[],
  concurrency = 8,
): Promise<TronBalanceResult[]> {
  const results: TronBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += concurrency) {
    const chunk = addresses.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(getTronBalance));

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error(`[tron] ${chunk[j]}: ${r.reason}`);
        results.push({ address: chunk[j], trx: 0n, usdt: 0n });
      }
    }

    if (i + concurrency < addresses.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}
