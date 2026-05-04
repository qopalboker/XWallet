/**
 * Worker process entry point.
 *
 * اجرا با:
 *   npm run worker
 *
 * این پروسه جدا از API server اجرا می‌شه تا load jobs بر API تأثیر نذاره.
 *
 * Phase 2 startup:
 *   - بعد از scheduling balance/cleanup، templateهای enabled رو لود می‌کنیم:
 *     • cron        → repeatable روی templateRunsQueue
 *     • on_startup  → اگه cooldown گذشته باشه یک‌بار fire (با runTemplate
 *                     trigger='on_startup')
 *   - circuit breaker (AUTO_BATCH_ENABLED) قبل از همه چیز چک می‌شه: اگه off
 *     باشه، هیچ template ای fire/scheduled نمی‌شه (cron repeatableها هم
 *     register نمی‌شن). برای فعال‌سازی بعدی، از پنل toggle می‌شه.
 */

import 'dotenv/config';
import { startGenerationWorker } from './queue/workers/generation.js';
import { startBalanceWorker } from './queue/workers/balance.js';
import { startCleanupWorker } from './queue/workers/cleanup.js';
import { startTemplateRunsWorker } from './queue/workers/template-runs.js';
import {
  scheduleRecurringBalanceChecks,
  scheduleRecurringCleanup,
  templateRunsQueue,
} from './queue/queues.js';
import {
  listEnabledByTrigger,
  shouldFireOnStartup,
  runTemplate,
  isAutoBatchEnabled,
  RunBlockedError,
} from './services/batch-templates-service.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './redis/client.js';

async function scheduleEnabledTemplates(): Promise<void> {
  const cb = await isAutoBatchEnabled();
  if (!cb.enabled) {
    console.log(
      `▶  AUTO_BATCH disabled (source=${cb.source}) — purging existing template schedulers.`
    );
    // وقتی circuit breaker بسته‌ست همه‌ی scheduler ها رو پاک کن تا BullMQ
    // در پس‌زمینه هیچی fire نکنه.
    const existing = await templateRunsQueue.getJobSchedulers();
    for (const s of existing) {
      if (s.id?.startsWith('tpl-cron:')) {
        try { await templateRunsQueue.removeJobScheduler(s.id); } catch { /* best-effort */ }
      }
    }
    return;
  }

  // ─── orphan cleanup: scheduler هایی که برای template حذف‌شده/disabled شده مونده‌ن
  // رو پاک کن. شکل ID ما 'tpl-cron:<id>' هست. هم registry جدید (jobScheduler)
  // و هم registry قدیمی (repeatable — از قبل از migration به API جدید) رو پاک می‌کنیم.
  const cronTpls = await listEnabledByTrigger('cron');
  const wantedIds = new Set(cronTpls.map((t) => `tpl-cron:${t.id}`));
  try {
    const schedulers = await templateRunsQueue.getJobSchedulers();
    for (const s of schedulers) {
      if (!s.id?.startsWith('tpl-cron:')) continue;
      if (!wantedIds.has(s.id)) {
        try {
          await templateRunsQueue.removeJobScheduler(s.id);
          console.log(`↷  removed orphan scheduler ${s.id}`);
        } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    console.warn('[startup] scheduler cleanup failed:', (e as Error).message);
  }
  try {
    // legacy repeatable cleanup. توی v5، add({repeat,...}) تو registry جدای
    // 'repeatable' می‌نشست. وقتی همه‌چی رو به upsertJobScheduler منتقل کردیم،
    // این‌ها همه orphan شدن. هرچی که نام = 'tpl-cron' داره رو پاک می‌کنیم.
    const repeatables = await templateRunsQueue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.name === 'tpl-cron') {
        try {
          await templateRunsQueue.removeRepeatableByKey(r.key);
          console.log(`↷  removed legacy repeatable ${r.key}`);
        } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    console.warn('[startup] legacy repeatable cleanup failed:', (e as Error).message);
  }

  // ─── cron triggers ───
  for (const t of cronTpls) {
    if (!t.cronExpr) continue;
    try {
      // API جدید v5: upsert تو registry "jobScheduler". idempotent — اگه
      // وجود داشته باشه expr رو override می‌کنه. هم‌خانواده با removeJobScheduler.
      await templateRunsQueue.upsertJobScheduler(
        `tpl-cron:${t.id}`,
        { pattern: t.cronExpr },
        {
          name: 'tpl-cron',
          data: { templateId: t.id, trigger: 'cron' as const },
        }
      );
      console.log(
        `✔  template "${t.name}" (#${t.id}) scheduled: cron="${t.cronExpr}"`
      );
    } catch (e) {
      console.error(
        `✖  failed to schedule template ${t.id} (${t.name}): ${(e as Error).message}`
      );
    }
  }

  // ─── on_startup triggers ───
  const startupTpls = await listEnabledByTrigger('on_startup');
  for (const t of startupTpls) {
    const decision = shouldFireOnStartup(t);
    if (!decision.fire) {
      console.log(
        `↷  template "${t.name}" (#${t.id}) on_startup skipped: ${decision.reason}`
      );
      continue;
    }
    try {
      const result = await runTemplate(t.id, 'on_startup', {
        adminId: null,
        username: 'system:on_startup',
        ip: null,
        userAgent: 'worker-startup',
      });
      console.log(
        `✔  template "${t.name}" (#${t.id}) on_startup fired: jobDbId=${result.jobDbId} reused=${result.reused}`
      );
    } catch (e) {
      if (e instanceof RunBlockedError) {
        console.warn(
          `↷  template "${t.name}" (#${t.id}) on_startup blocked: ${e.code} — ${e.message}`
        );
      } else {
        console.error(
          `✖  template "${t.name}" (#${t.id}) on_startup failed: ${(e as Error).message}`
        );
      }
    }
  }
}

async function main() {
  console.log('▶  starting workers...');

  const genWorker = startGenerationWorker();
  const balWorker = startBalanceWorker();
  const cleanupWorker = startCleanupWorker();
  const tplWorker = startTemplateRunsWorker();

  // Repeatable jobs (idempotent — اگه قبلاً ست شدن، override می‌شن)
  await scheduleRecurringBalanceChecks();
  await scheduleRecurringCleanup();
  console.log('✔  scheduled: balance check (~30s), cleanup (daily)');

  // Template-driven schedules
  try {
    await scheduleEnabledTemplates();
  } catch (e) {
    console.error('[startup] template scheduling failed:', (e as Error).message);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down workers...`);
    try {
      await Promise.all([
        genWorker.close(),
        balWorker.close(),
        cleanupWorker.close(),
        tplWorker.close(),
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
