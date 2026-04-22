/**
 * BullMQ queue definitions.
 *
 * صف‌ها:
 *   - wallet-generation: batch تولید ولت
 *   - balance-check:     چک موجودی (single repeatable + on-demand)
 *   - cleanup:           پاک‌سازی audit/sessions/old runs (روزانه)
 */

import { Queue } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from './connection.js';

// ─── Typed job data ───
export interface GenerationJobData {
  jobDbId: number;
  startUserId: number;
  count: number;
  wordCount: 12 | 24;
  addressesPerWallet: number;
}

export interface BalanceCheckJobData {
  // backward-compat: قبلاً priority سه مقداری داشت. الان فقط hint برای batchSize
  // و logging هست. scheduling اصلی بر اساس next_check_at تو DB انجام می‌شه.
  priority?: 'active' | 'normal' | 'inactive' | 'due';
  batchSize?: number;
}

export interface CleanupJobData {
  trigger: 'scheduled' | 'manual';
}

// یه connection share بین queue‌ها (producer side)
const producerConnection = createQueueConnection();

export const generationQueue = new Queue<GenerationJobData>(QUEUE_NAMES.GENERATION, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
    removeOnFail: { count: 500, age: 30 * 24 * 3600 },
  },
});

export const balanceQueue = new Queue<BalanceCheckJobData>(QUEUE_NAMES.BALANCE_CHECK, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

export const cleanupQueue = new Queue<CleanupJobData>(QUEUE_NAMES.CLEANUP, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 30 },
  },
});

/**
 * یه repeatable job که هر BALANCE_CHECK_INTERVAL_SEC ثانیه (پیش‌فرض ۳۰)
 * worker رو فرا می‌خونه. خود worker از DB آدرس‌های `next_check_at <= NOW()`
 * رو می‌گیره و چک می‌کنه.
 */
export async function scheduleRecurringBalanceChecks(): Promise<void> {
  const intervalSec = Number(process.env.BALANCE_CHECK_INTERVAL_SEC ?? 30);
  await balanceQueue.add(
    'check-due',
    { priority: 'due' },
    {
      repeat: { every: Math.max(5, intervalSec) * 1000 },
      jobId: 'recurring:due',
    }
  );
}

/** repeatable cleanup روزانه (default 03:00 UTC). */
export async function scheduleRecurringCleanup(): Promise<void> {
  const cron = process.env.CLEANUP_CRON ?? '0 3 * * *';
  await cleanupQueue.add(
    'cleanup',
    { trigger: 'scheduled' },
    {
      repeat: { pattern: cron },
      jobId: 'recurring:cleanup',
    }
  );
}
