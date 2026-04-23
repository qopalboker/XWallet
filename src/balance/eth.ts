/**
 * ETH + USDT-ERC20 balance checker با Multicall3.
 *
 * RPC endpoint‌ها از DB خونده می‌شن (با rotation). اگه هیچ کدوم نباشه،
 * fallback به default عمومی (llamarpc). روی هر batch یه RPC انتخاب می‌شه.
 *
 * Error classification:
 *   - 429 → markRateLimited(60s) و retry با credential دیگه
 *   - 401/403 → markAuthFailed (deactivate) و retry با credential دیگه
 *   - بقیهٔ خطاها → markError و throw (caller باید job level‌ش رو retry کنه)
 *
 * forBenchmark=true: فقط credential هایی که benchmark_allowed=true
 * دارن استفاده می‌شن (محافظ سهمیهٔ GetBlock). اگه هیچ کدوم نبود، سریع
 * NoAvailableCredential می‌ده (نه fall back به public RPC که خودش
 * rate-limit می‌خوره).
 */

import { JsonRpcProvider, Interface, Contract } from 'ethers';
import {
  pickCredential,
  markSuccess,
  markError,
  markRateLimited,
  markAuthFailed,
  NoAvailableCredential,
  type CredentialRow,
} from '../services/credentials-service.js';
import { redactGetBlockUrl } from '../services/getblock.js';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const USDT_ERC20 = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const FALLBACK_RPC = process.env.ETH_RPC ?? 'https://eth.llamarpc.com';
const MAX_ATTEMPTS = 3;

const multicall3Iface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256)',
]);

const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
]);

// Provider cache به ازای هر RPC URL (تا هر بار new نسازیم)
const providerCache = new Map<string, JsonRpcProvider>();

function getProvider(rpcUrl: string): JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
    providerCache.set(rpcUrl, p);
  }
  return p;
}

export interface EthBalanceResult {
  address: string;
  eth: bigint;
  usdt: bigint;
}

export interface BatchOpts {
  forBenchmark?: boolean;
}

export async function batchEthBalances(
  addresses: string[],
  opts: BatchOpts = {}
): Promise<EthBalanceResult[]> {
  if (addresses.length === 0) return [];

  const CHUNK = 300;
  const results: EthBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const chunkResults = await batchChunk(chunk, opts);
    results.push(...chunkResults);
  }

  return results;
}

/**
 * ethers به‌عنوان JsonRpcProvider خطاها رو wrap می‌کنه. از روی متنشون
 * تشخیص می‌دیم 429/401/403 هست یا یه خطای معمولی.
 */
function classifyEthersError(err: unknown): 'throttled' | 'auth_failed' | 'error' {
  const anyErr = err as { status?: number; info?: { status?: number }; message?: string };
  const status = anyErr?.status ?? anyErr?.info?.status;
  const msg = (anyErr?.message ?? '').toLowerCase();

  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'throttled';
  }
  if (
    status === 401 ||
    status === 403 ||
    / 401\b/.test(msg) ||
    / 403\b/.test(msg) ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  ) {
    return 'auth_failed';
  }
  return 'error';
}

async function batchChunk(
  addresses: string[],
  opts: BatchOpts
): Promise<EthBalanceResult[]> {
  const tried = new Set<number>();
  let lastErr: unknown;
  let usedFallback = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cred: CredentialRow | null = await pickCredential('eth_rpc', {
      forBenchmark: opts.forBenchmark,
      excludeIds: tried,
    });

    let rpcUrl: string;
    if (cred) {
      rpcUrl = cred.value;
      tried.add(cred.id);
    } else {
      // benchmark mode و هیچ credential مجاز نمونده → سریع fail کن تا
      // rate-limit public RPC سهمیهٔ کسی رو نخوره.
      if (opts.forBenchmark) {
        throw new NoAvailableCredential('eth_rpc', 'no benchmark-allowed credential');
      }
      if (usedFallback) break;
      rpcUrl = FALLBACK_RPC;
      usedFallback = true;
    }

    const provider = getProvider(rpcUrl);
    const multicall = new Contract(MULTICALL3_ADDRESS, multicall3Iface, provider);

    const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
    for (const addr of addresses) {
      calls.push({
        target: MULTICALL3_ADDRESS,
        allowFailure: false,
        callData: multicall3Iface.encodeFunctionData('getEthBalance', [addr]),
      });
      calls.push({
        target: USDT_ERC20,
        allowFailure: true,
        callData: erc20Iface.encodeFunctionData('balanceOf', [addr]),
      });
    }

    try {
      const aggregated = (await multicall.aggregate3(calls)) as Array<{
        success: boolean;
        returnData: string;
      }>;

      if (cred) await markSuccess(cred.id);

      return addresses.map((addr, i) => {
        const ethResult = aggregated[i * 2];
        const usdtResult = aggregated[i * 2 + 1];

        const eth = ethResult.success
          ? (multicall3Iface.decodeFunctionResult('getEthBalance', ethResult.returnData)[0] as bigint)
          : 0n;

        const usdt = usdtResult.success && usdtResult.returnData !== '0x'
          ? (erc20Iface.decodeFunctionResult('balanceOf', usdtResult.returnData)[0] as bigint)
          : 0n;

        return { address: addr, eth, usdt };
      });
    } catch (e) {
      lastErr = e;
      if (cred) {
        const cls = classifyEthersError(e);
        const safeMsg = redactGetBlockUrl((e as Error).message ?? String(e));
        if (cls === 'throttled') {
          await markRateLimited(cred.id, 60);
        } else if (cls === 'auth_failed') {
          await markAuthFailed(cred.id, safeMsg);
        } else {
          await markError(cred.id, safeMsg);
        }
        continue; // retry با credential بعدی
      }
      break; // fallback شکست خورد
    }
  }

  throw lastErr ?? new Error('eth batchChunk failed with no error');
}
