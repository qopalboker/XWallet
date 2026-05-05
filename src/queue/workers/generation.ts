/**
 * Generation worker — chunk-aware + chain-aware.
 *
 * هر BullMQ job یه chunk از parent generation_jobs row رو پردازش می‌کنه:
 *   1) (فقط chunkIndex=0): مارک parent به 'running'
 *   2) createWalletsBatch (یک تراکنش، UNNEST insert ها)
 *   3) atomic finalize: chunks_done++ ، در صورت تکمیل آخرین chunk، status نهایی ست می‌شه
 *   4) chain-spawn: اگه این chunk، آخرین chunk بود و parent یه template_id داشت
 *      و اون template status='active' بود، نسخه بعدی رو spawn می‌کنه.
 *
 * GEN_CONCURRENCY مشخص می‌کنه چند BullMQ job هم‌زمان (= چند chunk) پردازش بشن.
 * پیش‌فرض = max(1, cores - 1).
 */

import os from 'node:os';
import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { GenerationJobData } from '../queues.js';
import { templateChainQueue } from '../queues.js';
import { createWalletsBatch, createWallet } from '../../services/wallet-service.js';
import {
  runTemplate,
  getTemplate,
  setTemplateStatus,
  RunBlockedError,
  type AuditCtx,
} from '../../services/batch-templates-service.js';
import { pool } from '../../db/pool.js';

const MAX_ERROR_LEN = 2000;

const CHAIN_CTX: AuditCtx = {
  adminId: null,
  username: 'system:chain',
  ip: null,
  userAgent: 'generation-worker',
};

function defaultConcurrency(): number {
  const env = Number(process.env.GEN_CONCURRENCY);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, os.cpus().length - 1);
}

export interface FinalizeRow {
  id: string;
  status: string;
  chunks_done: number;
  chunks_total: number;
  template_id: string | null;
  parent_job_id: string | null;
}

/**
 * بعد از finalize parent job، تصمیم می‌گیره که chain ادامه پیدا کنه یا نه.
 *
 * اگه template_id null باشه، این یه ad-hoc job ست (POST /api/jobs مستقیم،
 * بدون template) و عضو هیچ chain ای نیست — early return.
 *
 * Exported برای تست؛ خود finalize handler تو همین فایل صداش می‌زنه.
 */
export async function maybeSpawnNext(row: FinalizeRow): Promise<void> {
  // ad-hoc job: template_id null → عضو هیچ chain ای نیست؛ early return.
  if (row.template_id == null) {
    return;
  }

  const templateId = Number(row.template_id);
  const parentJobId = Number(row.id);

  const t = await getTemplate(templateId);
  if (!t) {
    // template mid-flight حذف شده. chain به صورت طبیعی متوقف می‌شه.
    console.log(`[gen] chain stopped: template ${templateId} not found (parent=${parentJobId})`);
    return;
  }

  // parent finalize='failed' → chain رو خودکار pause می‌کنیم. فقط failed یعنی
  // هیچ ولتی ساخته نشد (zero progress) — ادامه دادن chain تو این حالت معمولاً
  // همون root cause رو دوباره trigger می‌کنه و user_id range رو می‌سوزونه.
  // partial و completed عادی spawn می‌کنن. اپراتور audit log می‌بینه و دستی
  // resume می‌کنه. failedJobId تو audit details رو می‌فرستیم تا کلیک‌پذیر بشه.
  if (row.status === 'failed') {
    if (t.status === 'active') {
      await setTemplateStatus(templateId, 'paused', CHAIN_CTX, {
        reason: 'auto_paused_on_failure',
        failedJobId: parentJobId,
      });
    }
    console.warn(
      `[gen] chain auto-paused: template=${templateId} parent=${parentJobId} status=failed`
    );
    return;
  }

  if (t.status !== 'active') {
    console.log(
      `[gen] chain skipped: template ${templateId} status=${t.status} (parent=${parentJobId})`
    );
    return;
  }

  // cooldown=0 → inline runTemplate تو همین context. سنگین نیست چون chunk
  // worker DB tx خودش رو الان تموم کرده.
  if (t.cooldownSeconds === 0) {
    try {
      const result = await runTemplate(templateId, 'chain', CHAIN_CTX, parentJobId);
      console.log(
        `[gen] chain spawn: template=${templateId} parent=${parentJobId} → jobDbId=${result.jobDbId}`
      );
    } catch (e) {
      if (e instanceof RunBlockedError) {
        console.warn(
          `[gen] chain spawn blocked: template=${templateId} parent=${parentJobId} ${e.code}: ${e.message}`
        );
      } else {
        throw e;
      }
    }
    return;
  }

  // cooldown > 0 → BullMQ delayed job می‌فرستیم تا روی restart worker از دست
  // نره. jobId از parentJobId مشتق می‌شه تا اگه به هر دلیل دو بار enqueue بشه،
  // BullMQ خودش drop کنه. شکل سه‌بخشی اجباریه چون BullMQ ≥5.7 jobIdهای
  // تک-کولون رو reject می‌کنه (.split(':').length باید 1 یا 3 باشه).
  await templateChainQueue.add(
    'chain-spawn',
    { templateId, parentJobId },
    {
      delay: t.cooldownSeconds * 1000,
      jobId: `chain:spawn:${parentJobId}`,
    }
  );
  console.log(
    `[gen] chain delayed: template=${templateId} parent=${parentJobId} cooldown=${t.cooldownSeconds}s`
  );
}

export function startGenerationWorker() {
  const concurrency = defaultConcurrency();
  console.log(`[gen] worker concurrency=${concurrency}`);

  const worker = new Worker<GenerationJobData>(
    QUEUE_NAMES.GENERATION,
    async (job) => {
      const {
        jobDbId,
        startUserId,
        count,
        wordCount,
        addressesPerWallet,
        chunkIndex = 0,
        chunksTotal = 1,
      } = job.data;

      // chunk اول → parent رو 'running' کن (idempotent — برای retry هم safe)
      if (chunkIndex === 0) {
        await pool.query(
          `UPDATE generation_jobs
             SET status = 'running',
                 started_at = COALESCE(started_at, NOW())
           WHERE id = $1 AND status IN ('pending', 'running')`,
          [jobDbId]
        );
      }

      // مسیر batch
      let result = await createWalletsBatch({
        startUserId,
        count,
        wordCount,
        addressesPerWallet,
      });

      // اگه batch tx fail کرد (مثلاً DB blip)، یه fallback کوچیک:
      // به‌ازای هر ولت یه createWallet جدا (مثل قبل) تا جای ممکن حفظ کنیم.
      // این باعث می‌شه یه chunk با حالت partial تموم بشه به‌جای 100% fail.
      if (result.failed === count && result.completed === 0) {
        console.warn(
          `[gen] batch failed for chunk ${chunkIndex}/${chunksTotal} of job ${jobDbId} — falling back to per-wallet`
        );
        let completed = 0;
        let failed = 0;
        const errors: string[] = [];
        for (let i = 0; i < count; i++) {
          try {
            await createWallet({
              userId: startUserId + i,
              wordCount,
              initialAddressCount: addressesPerWallet,
            });
            completed++;
          } catch (e) {
            failed++;
            if (errors.length < 5) {
              errors.push(`user_id=${startUserId + i}: ${(e as Error).message}`);
            }
          }
        }
        result = { completed, failed, errors };
      }

      const errorJoined = result.errors.length > 0 ? result.errors.join('\n') : null;

      // finalize atomic — اگه این آخرین chunk بود، status نهایی ست می‌شه.
      // PostgreSQL در یک UPDATE همه‌ی SET expressions رو روی snapshot قبل از
      // increment ارزیابی می‌کنه و row-level lock می‌گیره؛ پس chunks_done == chunks_total
      // فقط برای یک chunk درست در می‌آد.
      const fin = await pool.query<FinalizeRow>(
        `UPDATE generation_jobs
            SET completed     = completed + $1,
                failed_count  = failed_count + $2,
                chunks_done   = chunks_done + 1,
                error = CASE
                  WHEN $3::text IS NOT NULL
                       AND (error IS NULL OR LENGTH(error) < $5)
                  THEN LEFT(COALESCE(error || E'\n', '') || $3, $5)
                  ELSE error
                END,
                status = CASE
                  WHEN chunks_done + 1 >= chunks_total THEN
                    CASE
                      WHEN failed_count + $2 >= total_count THEN 'failed'
                      WHEN failed_count + $2 > 0           THEN 'partial'
                      ELSE 'completed'
                    END
                  ELSE status
                END,
                completed_at = CASE
                  WHEN chunks_done + 1 >= chunks_total THEN NOW()
                  ELSE completed_at
                END
          WHERE id = $4
        RETURNING id, status, chunks_done, chunks_total, template_id, parent_job_id`,
        [result.completed, result.failed, errorJoined, jobDbId, MAX_ERROR_LEN]
      );

      const row = fin.rows[0];
      const isLastChunk = row != null && row.chunks_done === row.chunks_total;

      if (isLastChunk) {
        try {
          await maybeSpawnNext(row);
        } catch (e) {
          // chain-spawn نباید parent finalize رو bricked کنه. log کن و رد شو.
          console.error(
            `[gen] chain spawn failed for parent=${row.id}: ${(e as Error).message}`
          );
        }
      }

      await job.updateProgress({
        chunkIndex,
        chunksTotal,
        completed: result.completed,
        failed: result.failed,
        total: count,
      });

      return {
        chunkIndex,
        chunksTotal,
        completed: result.completed,
        failed: result.failed,
        total: count,
      };
    },
    {
      connection: createQueueConnection(),
      concurrency,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[gen] job ${job.id} completed:`, job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    console.error(`[gen] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
