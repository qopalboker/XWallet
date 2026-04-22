/**
 * Balance check worker — schedule بر اساس next_check_at.
 *
 * هر job (که هر چند ثانیه یه بار فراخوانی می‌شه) آدرس‌هایی که next_check_at
 * منقضی شده رو میاره (تا batchSize)، چک می‌کنه، و next_check_at رو بر اساس
 * activity جدید محاسبه می‌کنه.
 *
 * tier ها (تا اپراتور بدونه چی پیش میاد):
 *   - active   (موجودی > 0 یا تغییر اخیر در ۱h): بعدی +ACTIVE_INTERVAL  (پیش‌فرض 2 min)
 *   - normal   (موجودی صفر، فعالیت اخیر در ۲۴h):  بعدی +NORMAL_INTERVAL  (پیش‌فرض 30 min)
 *   - cool     (موجودی صفر، 1-30 روز بدون فعالیت):  بعدی +COOL_INTERVAL    (پیش‌فرض 2 hr)
 *   - inactive (>30 روز بدون فعالیت):              بعدی +INACTIVE_INTERVAL (پیش‌فرض 12 hr)
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { BalanceCheckJobData } from '../queues.js';
import { pool } from '../../db/pool.js';
import { fetchBalancesByChain, setCached } from '../../balance/cache.js';

interface AddressRow {
  id: number;
  chain: 'BTC' | 'ETH' | 'TRON';
  address: string;
  native_balance: string;
  usdt_balance: string;
  last_balance_change_at: Date | null;
}

const intervalSec = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

const ACTIVE_S = intervalSec('ACTIVE_INTERVAL_SEC', 2 * 60);
const NORMAL_S = intervalSec('NORMAL_INTERVAL_SEC', 30 * 60);
const COOL_S = intervalSec('COOL_INTERVAL_SEC', 2 * 60 * 60);
const INACTIVE_S = intervalSec('INACTIVE_INTERVAL_SEC', 12 * 60 * 60);

function pickInterval(
  hasBalance: boolean,
  changedNow: boolean,
  lastChange: Date | null
): { seconds: number; tier: 'active' | 'normal' | 'cool' | 'inactive'; priority: 0 | 1 | 2 } {
  if (hasBalance || changedNow) {
    return { seconds: ACTIVE_S, tier: 'active', priority: 2 };
  }

  if (!lastChange) {
    return { seconds: NORMAL_S, tier: 'normal', priority: 1 };
  }

  const ageMs = Date.now() - new Date(lastChange).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (ageMs < dayMs) return { seconds: NORMAL_S, tier: 'normal', priority: 1 };
  if (ageMs < 30 * dayMs) return { seconds: COOL_S, tier: 'cool', priority: 1 };
  return { seconds: INACTIVE_S, tier: 'inactive', priority: 0 };
}

export function startBalanceWorker(): Worker {
  const worker = new Worker<BalanceCheckJobData>(
    QUEUE_NAMES.BALANCE_CHECK,
    async (job) => {
      const batchSize = job.data.batchSize ?? 200;

      // آدرس‌های due
      const res = await pool.query<AddressRow>(
        `SELECT id, chain, address,
                native_balance::text, usdt_balance::text,
                last_balance_change_at
         FROM addresses
         WHERE status = 'active'
           AND next_check_at <= NOW()
         ORDER BY next_check_at ASC
         LIMIT $1`,
        [batchSize]
      );

      if (res.rows.length === 0) {
        return { checked: 0, changed: 0 };
      }

      const byChain = {
        BTC: [] as AddressRow[],
        ETH: [] as AddressRow[],
        TRON: [] as AddressRow[],
      };
      for (const row of res.rows) byChain[row.chain].push(row);

      const fetched = await fetchBalancesByChain(
        byChain.BTC.map((r) => r.address),
        byChain.ETH.map((r) => r.address),
        byChain.TRON.map((r) => r.address)
      );

      const ids: number[] = [];
      const natives: string[] = [];
      const usdts: string[] = [];
      const changedFlags: boolean[] = [];
      const nextChecks: string[] = []; // ISO strings
      const priorities: number[] = [];

      const tiersCount = { active: 0, normal: 0, cool: 0, inactive: 0 };

      const process = (rows: AddressRow[], extract: (addr: string) => { native: string; usdt: string } | null) => {
        for (const row of rows) {
          const out = extract(row.address);
          if (!out) continue;

          const changed = out.native !== row.native_balance || out.usdt !== row.usdt_balance;
          const hasBalance = out.native !== '0' || out.usdt !== '0';
          const decision = pickInterval(hasBalance, changed, row.last_balance_change_at);

          ids.push(row.id);
          natives.push(out.native);
          usdts.push(out.usdt);
          changedFlags.push(changed);
          nextChecks.push(new Date(Date.now() + decision.seconds * 1000).toISOString());
          priorities.push(decision.priority);
          tiersCount[decision.tier]++;

          // Redis cache
          void setCached(
            row.chain,
            row.address,
            { native: out.native, usdt: out.usdt, checkedAt: Date.now() },
            decision.priority
          );
        }
      };

      process(byChain.BTC, (addr) => {
        const b = fetched.btc.get(addr);
        if (!b) return null;
        return { native: b.sats.toString(), usdt: '0' };
      });

      process(byChain.ETH, (addr) => {
        const b = fetched.eth.get(addr);
        if (!b) return null;
        return { native: b.eth.toString(), usdt: b.usdt.toString() };
      });

      process(byChain.TRON, (addr) => {
        const b = fetched.tron.get(addr);
        if (!b) return null;
        return { native: b.trx.toString(), usdt: b.usdt.toString() };
      });

      if (ids.length === 0) return { checked: 0, changed: 0 };

      // Bulk update — UNNEST برای performance
      await pool.query(
        `UPDATE addresses a
         SET native_balance = v.native,
             usdt_balance = v.usdt,
             last_checked_at = NOW(),
             last_balance_change_at = CASE WHEN v.changed THEN NOW() ELSE a.last_balance_change_at END,
             priority = v.priority,
             next_check_at = v.next_check_at::timestamptz
         FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[], $4::boolean[], $5::text[], $6::int[])
              AS v(id, native, usdt, changed, next_check_at, priority)
         WHERE a.id = v.id`,
        [ids, natives, usdts, changedFlags, nextChecks, priorities]
      );

      const changedCount = changedFlags.filter(Boolean).length;
      return { checked: ids.length, changed: changedCount, tiers: tiersCount };
    },
    {
      connection: createQueueConnection(),
      concurrency: Number(process.env.BALANCE_CONCURRENCY ?? 3),
    }
  );

  worker.on('completed', (job) => {
    const r = job.returnvalue as { checked: number; changed: number; tiers?: Record<string, number> };
    if (r.checked > 0) {
      console.log(`[bal] checked=${r.checked} changed=${r.changed} tiers=${JSON.stringify(r.tiers ?? {})}`);
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[bal] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
