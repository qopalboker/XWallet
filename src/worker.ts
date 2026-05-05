/**
 * Worker process entry point.
 *
 * اجرا با:
 *   npm run worker
 *
 * این پروسه جدا از API server اجرا می‌شه تا load jobs بر API تأثیر نذاره.
 *
 * Phase 3 (chain-on-completion):
 *   - دیگه startup-fire و cron-schedule نداریم. هر template که status='active'
 *     داره بعد از یه manual /start از طریق API، با completion هر batch
 *     خودکار batch بعدی رو spawn می‌کنه. spawn-handler تو generation worker
 *     زندگی می‌کنه (src/queue/workers/generation.ts).
 *   - circuit breaker (AUTO_BATCH_ENABLED) سراسری کار می‌کنه: اگه off باشه،
 *     runTemplate (هم manual هم chain) RunBlockedError می‌ندازه.
 */

import 'dotenv/config';
import { startGenerationWorker } from './queue/workers/generation.js';
import { startBalanceWorker } from './queue/workers/balance.js';
import { startCleanupWorker } from './queue/workers/cleanup.js';
import { startTemplateChainWorker } from './queue/workers/template-chain.js';
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
  const chainWorker = startTemplateChainWorker();

  // Repeatable jobs (idempotent — اگه قبلاً ست شدن، override می‌شن)
  await scheduleRecurringBalanceChecks();
  await scheduleRecurringCleanup();
  console.log('✔  scheduled: balance check (~30s), cleanup (daily)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down workers...`);
    try {
      await Promise.all([
        genWorker.close(),
        balWorker.close(),
        cleanupWorker.close(),
        chainWorker.close(),
      ]);
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
