/**
 * Template-runs worker.
 *
 * Repeatable job ها روی template-runs queue ست می‌شن (با cron pattern از خود
 * template). هر بار که fire می‌شن، این worker:
 *   1) circuit breaker رو دوباره چک می‌کنه (تو runTemplate هم هست، ولی این‌جا
 *      زودتر skip کنیم تا audit log منطقی بمونه)
 *   2) runTemplate رو با trigger='cron' صدا می‌زنه
 *
 * runTemplate خودش idempotent ست؛ اگه اجرای قبلی هنوز running ست، همون رو
 * برمی‌گردونه و تو DB چیزی duplicate نمی‌شه.
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
        const result = await runTemplate(templateId, 'cron', SYSTEM_CTX);
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
