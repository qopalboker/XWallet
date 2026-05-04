/**
 * Generation worker — chunk-aware.
 *
 * هر BullMQ job یه chunk از parent generation_jobs row رو پردازش می‌کنه:
 *   1) (فقط chunkIndex=0): مارک parent به 'running'
 *   2) createWalletsBatch (یک تراکنش، UNNEST insert ها)
 *   3) atomic finalize: chunks_done++ ، در صورت تکمیل آخرین chunk، status نهایی ست می‌شه
 *
 * GEN_CONCURRENCY مشخص می‌کنه چند BullMQ job هم‌زمان (= چند chunk) پردازش بشن.
 * پیش‌فرض = max(1, cores - 1).
 */

import os from 'node:os';
import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { GenerationJobData } from '../queues.js';
import { createWalletsBatch, createWallet } from '../../services/wallet-service.js';
import { pool } from '../../db/pool.js';

const MAX_ERROR_LEN = 2000;

function defaultConcurrency(): number {
  const env = Number(process.env.GEN_CONCURRENCY);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, os.cpus().length - 1);
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
      await pool.query(
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
          WHERE id = $4`,
        [result.completed, result.failed, errorJoined, jobDbId, MAX_ERROR_LEN]
      );

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
