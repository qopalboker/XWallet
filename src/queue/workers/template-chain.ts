/**
 * Template-chain worker.
 *
 * Consumer برای `template-chain` queue. هر job (فقط برای cooldown > 0) شامل
 * (templateId, parentJobId) ست. این worker runTemplate رو با trigger='chain'
 * صدا می‌زنه و چون parent_job_id رو می‌فرسته، unique-index روی generation_jobs
 * ضامن idempotency ست — اگه به هر دلیل دوتا spawn handler با همون parentJobId
 * race کنن، یکی 23505 می‌گیره.
 *
 * cooldown=0 جداگونه inline تو generation worker spawn می‌شه، نه از این صف.
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { TemplateChainJobData } from '../queues.js';
import {
  runTemplate,
  RunBlockedError,
  type AuditCtx,
} from '../../services/batch-templates-service.js';

const SYSTEM_CTX: AuditCtx = {
  adminId: null,
  username: 'system:chain',
  ip: null,
  userAgent: 'bullmq-chain',
};

export function startTemplateChainWorker(): Worker {
  const worker = new Worker<TemplateChainJobData>(
    QUEUE_NAMES.TEMPLATE_CHAIN,
    async (job) => {
      const { templateId, parentJobId } = job.data;
      try {
        const result = await runTemplate(templateId, 'chain', SYSTEM_CTX, parentJobId);
        console.log(
          `[chain] template ${templateId} parent=${parentJobId} → jobDbId=${result.jobDbId} reused=${result.reused}`
        );
        return result;
      } catch (e) {
        if (e instanceof RunBlockedError) {
          // paused / overlap / disabled — chain به صورت طبیعی میسته. log کن و success
          // برگرد تا BullMQ retry نکنه.
          console.warn(
            `[chain] template ${templateId} parent=${parentJobId} blocked: ${e.code} — ${e.message}`
          );
          return { skipped: true, reason: e.code };
        }
        throw e;
      }
    },
    { connection: createQueueConnection(), concurrency: 4 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[chain] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
