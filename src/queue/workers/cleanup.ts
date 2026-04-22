/**
 * Cleanup worker — BullMQ repeatable job.
 *
 * یه بار در روز اجرا می‌شه و موارد زیر رو پاک می‌کنه:
 *   - admin_audit_log         > AUDIT_LOG_RETENTION_DAYS (90)
 *   - mnemonic_access_log     > MNEMONIC_LOG_RETENTION_DAYS (365)
 *   - admin_sessions revoked/expired > SESSION_RETENTION_DAYS (7)
 *   - benchmark_runs                > BENCHMARK_RETENTION_DAYS (180)
 *   - generation_jobs که completed/failed و خیلی قدیمی هستن > 90 days
 *
 * threshold ها از env قابل تنظیم.
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import { pool } from '../../db/pool.js';

interface CleanupResult {
  audit: number;
  mnemonicAccess: number;
  sessions: number;
  benchmarks: number;
  generationJobs: number;
}

function envDays(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export async function runCleanup(): Promise<CleanupResult> {
  const auditDays = envDays('AUDIT_LOG_RETENTION_DAYS', 90);
  const mnemonicDays = envDays('MNEMONIC_LOG_RETENTION_DAYS', 365);
  const sessionDays = envDays('SESSION_RETENTION_DAYS', 7);
  const benchmarkDays = envDays('BENCHMARK_RETENTION_DAYS', 180);
  const jobDays = envDays('GENERATION_JOB_RETENTION_DAYS', 90);

  const [audit, mnemonicAccess, sessions, benchmarks, generationJobs] = await Promise.all([
    pool.query(
      `DELETE FROM admin_audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [auditDays.toString()]
    ),
    pool.query(
      `DELETE FROM mnemonic_access_log WHERE accessed_at < NOW() - ($1 || ' days')::interval`,
      [mnemonicDays.toString()]
    ),
    pool.query(
      `DELETE FROM admin_sessions
       WHERE (revoked = true AND created_at < NOW() - ($1 || ' days')::interval)
          OR (expires_at < NOW() - ($1 || ' days')::interval)`,
      [sessionDays.toString()]
    ),
    pool.query(
      `DELETE FROM benchmark_runs
       WHERE status IN ('completed', 'stopped', 'failed')
         AND COALESCE(completed_at, created_at) < NOW() - ($1 || ' days')::interval`,
      [benchmarkDays.toString()]
    ),
    pool.query(
      `DELETE FROM generation_jobs
       WHERE status IN ('completed', 'partial', 'failed')
         AND COALESCE(completed_at, created_at) < NOW() - ($1 || ' days')::interval`,
      [jobDays.toString()]
    ),
  ]);

  return {
    audit: audit.rowCount ?? 0,
    mnemonicAccess: mnemonicAccess.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    benchmarks: benchmarks.rowCount ?? 0,
    generationJobs: generationJobs.rowCount ?? 0,
  };
}

export function startCleanupWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.CLEANUP,
    async (job) => {
      const result = await runCleanup();
      job.log(`cleanup result: ${JSON.stringify(result)}`).catch(() => undefined);
      return result;
    },
    {
      connection: createQueueConnection(),
      concurrency: 1,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[cleanup] job ${job.id} ok:`, job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    console.error(`[cleanup] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
