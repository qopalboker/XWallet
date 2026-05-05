/**
 * Template-runs worker — Phase 3: idle.
 *
 * تو نسخهٔ قبل cron-driven repeatable job ها رو consume می‌کرد. الان با
 * chain-on-completion هیچ producer ای روی این queue نیست. این فایل تا commit
 * بعدی که delete می‌کنه فقط برای buildable نگه‌داشتن intermediate commit
 * زنده‌ست.
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { TemplateRunJobData } from '../queues.js';
import {
  runTemplate,
  isAutoBatchEnabled,
  RunBlockedError,
  type AuditCtx,
} from '../../services/batch-templates-service.js';

const SYSTEM_CTX: AuditCtx = {
  adminId: null,
  username: 'system:cron',
  ip: null,
  userAgent: 'bullmq-cron',
};

export function startTemplateRunsWorker(): Worker {
  const worker = new Worker<TemplateRunJobData>(
    QUEUE_NAMES.TEMPLATE_RUNS,
    async (job) => {
      const { templateId } = job.data;

      const cb = await isAutoBatchEnabled();
      if (!cb.enabled) {
        console.log(
          `[tpl-cron] template ${templateId} skipped: auto-batch disabled (source=${cb.source})`
        );
        return { skipped: true, reason: 'auto_batch_disabled', source: cb.source };
      }

      try {
        const result = await runTemplate(templateId, 'chain', SYSTEM_CTX);
        console.log(
          `[tpl-cron] template ${templateId} fired: jobDbId=${result.jobDbId} reused=${result.reused}`
        );
        return result;
      } catch (e) {
        if (e instanceof RunBlockedError) {
          // overlap/disabled/etc — هندل نشدنی توسط BullMQ، فقط log کن و success برگرد
          // (نمی‌خوایم retry بشه، چون مشکل ساختاری ست)
          console.warn(
            `[tpl-cron] template ${templateId} blocked: ${e.code} — ${e.message}`
          );
          return { skipped: true, reason: e.code };
        }
        throw e;
      }
    },
    { connection: createQueueConnection(), concurrency: 1 }
  );

  worker.on('completed', (job) => {
    if (job.returnvalue && (job.returnvalue as { skipped?: boolean }).skipped) {
      // log قبلاً انجام شد
      return;
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[tpl-cron] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
