/**
 * Empty wallet cleanup worker.
 *
 * هر ولت تازه‌ساخته‌شده یه delayed job (۱۰ ثانیه) می‌گیره. این worker وقتی
 * job اجرا می‌شه آدرس‌های ولت رو می‌گیره، موجودی واقعی هرکدوم رو از RPC
 * می‌خونه؛ اگه همه‌شون صفر بودن، ولت رو حذف می‌کنه (CASCADE آدرس‌ها رو هم
 * می‌بره).
 *
 * نکته: اگه fetch موجودی fail کنه، ولت رو حذف نمی‌کنیم (ایمن‌تره ولت بمونه
 * تا حذف اشتباهی).
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { EmptyWalletCleanupJobData } from '../queues.js';
import { pool } from '../../db/pool.js';
import { fetchBalancesByChain } from '../../balance/cache.js';

interface AddressRow {
  chain: 'BTC' | 'ETH' | 'TRON';
  address: string;
}

export async function deleteIfEmpty(walletId: number): Promise<boolean> {
  const res = await pool.query<AddressRow>(
    `SELECT chain, address FROM addresses WHERE wallet_id = $1`,
    [walletId]
  );
  if (res.rows.length === 0) {
    // ولت بدون آدرس → خالی محسوب می‌شه و حذف می‌شه
    await pool.query(`DELETE FROM wallets WHERE id = $1`, [walletId]);
    return true;
  }

  const btc: string[] = [];
  const eth: string[] = [];
  const tron: string[] = [];
  for (const r of res.rows) {
    if (r.chain === 'BTC') btc.push(r.address);
    else if (r.chain === 'ETH') eth.push(r.address);
    else if (r.chain === 'TRON') tron.push(r.address);
  }

  let fetched;
  try {
    fetched = await fetchBalancesByChain(btc, eth, tron);
  } catch (e) {
    console.warn(
      `[empty-wallet] balance fetch failed for wallet=${walletId} — keeping wallet`,
      (e as Error).message
    );
    return false;
  }

  let hasBalance = false;
  for (const a of btc) {
    const b = fetched.btc.get(a);
    if (b && b.sats > 0n) { hasBalance = true; break; }
  }
  if (!hasBalance) {
    for (const a of eth) {
      const b = fetched.eth.get(a);
      if (b && (b.eth > 0n || b.usdt > 0n)) { hasBalance = true; break; }
    }
  }
  if (!hasBalance) {
    for (const a of tron) {
      const b = fetched.tron.get(a);
      if (b && (b.trx > 0n || b.usdt > 0n)) { hasBalance = true; break; }
    }
  }

  if (hasBalance) return false;

  // CASCADE روی addresses set شده، فقط wallet رو حذف می‌کنیم.
  const del = await pool.query(`DELETE FROM wallets WHERE id = $1`, [walletId]);
  return (del.rowCount ?? 0) > 0;
}

export function startEmptyWalletCleanupWorker(): Worker {
  const worker = new Worker<EmptyWalletCleanupJobData>(
    QUEUE_NAMES.EMPTY_WALLET_CLEANUP,
    async (job) => {
      const deleted = await deleteIfEmpty(job.data.walletId);
      return { walletId: job.data.walletId, deleted };
    },
    {
      connection: createQueueConnection(),
      concurrency: Math.max(1, Number(process.env.EMPTY_WALLET_CLEANUP_CONCURRENCY) || 5),
    }
  );

  worker.on('completed', (job) => {
    const r = job.returnvalue as { walletId: number; deleted: boolean };
    if (r?.deleted) {
      console.log(`[empty-wallet] wallet=${r.walletId} deleted (no balance after 10s)`);
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[empty-wallet] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
