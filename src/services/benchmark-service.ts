/**
 * Educational Benchmark Service.
 *
 * هر run:
 *   - یه target_count مشخص داره (حداکثر MAX_TARGET)
 *   - mnemonic random می‌سازه، آدرس derive می‌کنه، موجودی چک می‌کنه
 *   - mnemonic بعد از مصرف به‌صورت best-effort overwrite می‌شه
 *     (true wipe در JS برای string ممکن نیست، ولی entropy/seed buffer هایی
 *     که ساختیم رو با randomFillSync پاک می‌کنیم)
 *   - اگه hit شد (ریاضیاً نخواهد شد)، آدرس و موجودی و mnemonic متناظر ثبت
 *     می‌شن با jsonb concat (append-only، نه overwrite کل آرایه) تا اپراتور
 *     بتونه ولت پیداشده رو recover کنه
 *   - mnemonic فقط برای hit ها ذخیره می‌شه؛ برای میلیون‌ها try بی‌اثر، چیزی
 *     ذخیره نمی‌شه
 *
 * هم‌زمان فقط یه run می‌تونه اجرا بشه.
 */

import { randomFillSync } from 'node:crypto';
import { pool } from '../db/pool.js';
import {
  generateMnemonicForBenchmark,
  deriveMany,
  type Chain,
  type DerivedAddress,
} from '../wallet/derivation.js';
import { fetchBalancesByChain } from '../balance/cache.js';

// ═════════════ HARD LIMITS ═════════════
export const MAX_TARGET = 100_000;
export const BATCH_SIZE = 20;
export const BATCH_DELAY_MS = 500;
// ═══════════════════════════════════════

let currentRunId: number | null = null;
let stopRequested = false;

export function getCurrentRunId(): number | null {
  return currentRunId;
}

export async function requestStop(): Promise<void> {
  stopRequested = true;
}

export interface StartOptions {
  targetCount: number;
  wordCount: 12 | 24;
  addressesPerMnemonic: number;
  chains: Chain[];
  adminId: number;
}

export async function startBenchmark(opts: StartOptions): Promise<number> {
  if (currentRunId !== null) {
    throw new Error('یه benchmark در حال اجراست، اول صبر کن تموم بشه یا stopش کن');
  }

  const target = Math.min(MAX_TARGET, Math.max(1, opts.targetCount));
  const wordCount: 12 | 24 = opts.wordCount === 24 ? 24 : 12;
  const n = Math.max(1, Math.min(10, opts.addressesPerMnemonic));
  const chains = opts.chains.filter((c) => ['BTC', 'ETH', 'TRON'].includes(c));

  if (chains.length === 0) {
    throw new Error('حداقل یه chain انتخاب کن');
  }

  const res = await pool.query<{ id: number }>(
    `INSERT INTO benchmark_runs
     (word_count, addresses_per_mnemonic, target_count, chains, status, started_at, started_by)
     VALUES ($1, $2, $3, $4, 'running', NOW(), $5)
     RETURNING id`,
    [wordCount, n, target, chains, opts.adminId]
  );
  const runId = res.rows[0].id;
  currentRunId = runId;
  stopRequested = false;

  runLoop(runId, target, wordCount, n, chains)
    .catch(async (e) => {
      console.error('[benchmark] error:', e);
      await pool.query(
        `UPDATE benchmark_runs
         SET status = 'failed', error = $1, completed_at = NOW()
         WHERE id = $2`,
        [(e as Error).message, runId]
      );
    })
    .finally(() => {
      if (currentRunId === runId) currentRunId = null;
      stopRequested = false;
    });

  return runId;
}

interface NewHit {
  chain: string;
  address: string;
  native: string;
  usdt: string;
  mnemonic: string;
}

async function runLoop(
  runId: number,
  target: number,
  wordCount: 12 | 24,
  n: number,
  chains: Chain[]
): Promise<void> {
  const startTime = Date.now();
  let checked = 0;
  let totalHits = 0;

  while (checked < target && !stopRequested) {
    const remaining = target - checked;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    const batch: Array<{ addresses: DerivedAddress[]; mnemonic: string }> = [];

    for (let i = 0; i < batchSize; i++) {
      // entropy + mnemonic در یه helper داخلی نگه‌داشته می‌شه
      // و بعد از derive، entropy buffer با randomFillSync overwrite می‌شه.
      // خود رشتهٔ mnemonic رو نگه می‌داریم تا اگه آدرسی موجودی داشت، بتونیم
      // ذخیره‌اش کنیم. برای non-hit ها بعد از batch رها می‌شه (GC).
      const handle = generateMnemonicForBenchmark(wordCount);
      const addresses = await deriveMany(
        handle.mnemonic,
        chains.map((chain) => ({ chain, fromIndex: 0, count: n }))
      );
      batch.push({ addresses, mnemonic: handle.mnemonic });
      handle.wipe();
    }

    // چک موجودی
    const byChain: Record<Chain, string[]> = { BTC: [], ETH: [], TRON: [] };
    for (const item of batch) {
      for (const addr of item.addresses) byChain[addr.chain].push(addr.address);
    }

    const balances = await fetchBalancesByChain(byChain.BTC, byChain.ETH, byChain.TRON, {
      forBenchmark: true,
    });

    // پردازش — فقط hit های جدید این batch
    const newHits: NewHit[] = [];
    for (const item of batch) {
      for (const addr of item.addresses) {
        let native = 0n;
        let usdt = 0n;
        if (addr.chain === 'BTC') {
          const b = balances.btc.get(addr.address);
          if (b) native = b.sats;
        } else if (addr.chain === 'ETH') {
          const b = balances.eth.get(addr.address);
          if (b) {
            native = b.eth;
            usdt = b.usdt;
          }
        } else if (addr.chain === 'TRON') {
          const b = balances.tron.get(addr.address);
          if (b) {
            native = b.trx;
            usdt = b.usdt;
          }
        }

        if (native > 0n || usdt > 0n) {
          newHits.push({
            chain: addr.chain,
            address: addr.address,
            native: native.toString(),
            usdt: usdt.toString(),
            mnemonic: item.mnemonic,
          });
        }
      }
    }

    checked += batchSize;
    totalHits += newHits.length;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = checked / Math.max(1, elapsed);

    // Progress update — همیشه. سبک.
    await pool.query(
      `UPDATE benchmark_runs
       SET checked_count = $1,
           hit_count = $2,
           avg_rate_per_sec = $3
       WHERE id = $4`,
      [checked, totalHits, rate.toFixed(2), runId]
    );

    // Hits update — فقط وقتی hit جدید داریم. jsonb concat نه overwrite.
    if (newHits.length > 0) {
      await pool.query(
        `UPDATE benchmark_runs
           SET hits_info = hits_info || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(newHits), runId]
      );
    }

    if (BATCH_DELAY_MS > 0 && checked < target && !stopRequested) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // پایان
  const duration = Date.now() - startTime;
  const finalStatus = stopRequested ? 'stopped' : 'completed';

  await pool.query(
    `UPDATE benchmark_runs
     SET status = $1, completed_at = NOW(), duration_ms = $2
     WHERE id = $3`,
    [finalStatus, duration, runId]
  );

  console.log(
    `[benchmark] run #${runId} ${finalStatus}: checked=${checked}, hits=${totalHits}, duration=${(duration / 1000).toFixed(1)}s`
  );
}

/** اگه API restart بشه، run های ناتمام رو 'failed' علامت بزن */
export async function cleanupOnStartup(): Promise<void> {
  await pool.query(
    `UPDATE benchmark_runs
     SET status = 'failed',
         error = 'interrupted by server restart',
         completed_at = NOW()
     WHERE status IN ('pending', 'running')`
  );
}

// helper برای wipe کردن یه buffer (اگه بعداً جای دیگه نیاز شد)
export function secureWipe(buf: Buffer): void {
  randomFillSync(buf);
  buf.fill(0);
}
