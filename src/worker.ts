/**
 * Worker process entry point.
 *
 * اجرا با:
 *   npm run worker
 *
 * این پروسه جدا از API server اجرا می‌شه تا load jobs بر API تأثیر نذاره.
 */

import 'dotenv/config';
import { startGenerationWorker } from './queue/workers/generation.js';
import { startBalanceWorker } from './queue/workers/balance.js';
import { startCleanupWorker } from './queue/workers/cleanup.js';
import {
  scheduleRecurringBalanceChecks,
  scheduleRecurringCleanup,
} from './queue/queues.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './redis/client.js';

async function main() {
  console.log('▶  starting workers...');

  const genWorker = startGenerationWorker();
  const balWorker = startBalanceWorker();
  const cleanupWorker = startCleanupWorker();

  // Repeatable jobs (idempotent — اگه قبلاً ست شدن، override می‌شن)
  await scheduleRecurringBalanceChecks();
  await scheduleRecurringCleanup();
  console.log('✔  scheduled: balance check (~30s), cleanup (daily)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down workers...`);
    try {
      await Promise.all([genWorker.close(), balWorker.close(), cleanupWorker.close()]);
      await closePool();
      await closeRedis();
      process.exit(0);
    } catch (e) {
      console.error('shutdown error:', e);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log('✔  workers running. Ctrl+C برای توقف.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
