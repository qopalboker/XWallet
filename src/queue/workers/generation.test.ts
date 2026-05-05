/**
 * Chain-spawn integration tests for the generation worker.
 *
 * این تست‌ها با Postgres + Redis زنده کار می‌کنن. به همین خاطر فقط وقتی
 * BATCH_TPL_INTEGRATION=1 ست شده باشه fire می‌شن. اجرا:
 *
 *   docker compose up -d postgres redis
 *   BATCH_TPL_INTEGRATION=1 npx tsx --test src/queue/workers/generation.test.ts
 *
 * هر تست template و generation_jobs جدید با namespace یکتا می‌سازه و تو finally
 * تمیز می‌کنه. wallet ها رو با startUserId خیلی بالا (≥ 1e8) درست می‌کنیم تا
 * با data واقعی برخورد نکنن.
 */

/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, closePool } from '../../db/pool.js';
import { templateChainQueue } from '../queues.js';
import { closeRedis } from '../../redis/client.js';
import { maybeSpawnNext, type FinalizeRow } from './generation.js';
import {
  createTemplate,
  setTemplateStatus,
  getTemplate,
  type AuditCtx,
  type BatchTemplate,
} from '../../services/batch-templates-service.js';

const integrationDescribe = process.env.BATCH_TPL_INTEGRATION ? describe : describe.skip;

const SYS_CTX: AuditCtx = { adminId: null, username: 'test', ip: null, userAgent: 'test' };

// startUserId base — بالا انتخاب می‌شه تا با wallets واقعی collide نکنه. هر تست
// این رو با offset خودش جلو می‌بره و در نهایت پاک می‌کنه.
const TEST_USER_ID_BASE = 100_000_000;
let userIdOffset = 0;
function nextStartUserId(): number {
  userIdOffset += 10;
  return TEST_USER_ID_BASE + userIdOffset;
}

async function makeTemplate(opts: {
  status?: 'active' | 'paused';
  cooldownSeconds?: number;
} = {}): Promise<BatchTemplate> {
  const startUserId = nextStartUserId();
  const name = `test_chain_${startUserId}`;
  const t = await createTemplate(
    {
      name,
      status: opts.status ?? 'active',
      cooldownSeconds: opts.cooldownSeconds ?? 0,
      spec: {
        wordCount: 12,
        addressesPerWallet: 1,
        count: 1,
        chunkSize: 1,
        startUserId,
      },
    },
    SYS_CTX,
  );
  return t;
}

async function makeFinalizedJob(
  templateId: number | null,
  status: 'completed' | 'partial' | 'failed' = 'completed',
): Promise<FinalizeRow> {
  const startUserId = nextStartUserId();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO generation_jobs
       (word_count, total_count, status,
        chunks_total, chunks_done, failed_count,
        addresses_per_wallet, start_user_id,
        completed, template_id, parent_job_id)
     VALUES (12, 1, $1, 1, 1, 0, 1, $2, 1, $3, NULL)
     RETURNING id`,
    [status, startUserId, templateId],
  );
  return {
    id: r.rows[0].id,
    status,
    chunks_done: 1,
    chunks_total: 1,
    template_id: templateId == null ? null : String(templateId),
    parent_job_id: null,
  };
}

async function cleanup(templateIds: number[]): Promise<void> {
  if (templateIds.length === 0) return;
  // Order matters: jobs reference templates via FK (SET NULL), but parent_job_id
  // references generation_jobs (also SET NULL) — for clean teardown delete in
  // a transaction touching all related rows.
  await pool.query(
    `DELETE FROM wallets WHERE user_id >= $1`,
    [TEST_USER_ID_BASE],
  );
  await pool.query(
    `DELETE FROM generation_jobs WHERE template_id = ANY($1::bigint[])`,
    [templateIds],
  );
  await pool.query(
    `DELETE FROM batch_templates WHERE id = ANY($1::bigint[])`,
    [templateIds],
  );
}

async function removeChainJob(parentJobId: number): Promise<void> {
  const job = await templateChainQueue.getJob(`chain:spawn:${parentJobId}`);
  if (job) await job.remove();
}

integrationDescribe('maybeSpawnNext — chain spawn behavior', () => {
  it('happy path: active template + completed parent → child job inserted', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      await maybeSpawnNext(parent);

      const r = await pool.query<{ id: string }>(
        `SELECT id FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(r.rows.length, 1, 'exactly one child should be spawned');
    } finally {
      await cleanup([t.id]);
    }
  });

  it('paused template → no spawn', async () => {
    const t = await makeTemplate({ status: 'paused', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      await maybeSpawnNext(parent);

      const r = await pool.query(
        `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(r.rows.length, 0, 'paused chain must not spawn');
    } finally {
      await cleanup([t.id]);
    }
  });

  it('cooldown > 0 → no inline INSERT, delayed BullMQ job enqueued', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 7 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      await maybeSpawnNext(parent);

      const inline = await pool.query(
        `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(inline.rows.length, 0, 'cooldown path must not insert inline');

      const job = await templateChainQueue.getJob(`chain:spawn:${parent.id}`);
      assert.ok(job, 'a delayed BullMQ job should be enqueued');
      assert.equal(job!.data.templateId, t.id);
      assert.equal(job!.data.parentJobId, Number(parent.id));
      assert.ok((job!.delay ?? 0) > 0, `delay should be positive, got ${job!.delay}`);
    } finally {
      await removeChainJob(Number(parent.id));
      await cleanup([t.id]);
    }
  });

  it('failed parent → template auto-paused with audit details, no spawn', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'failed');
    try {
      await maybeSpawnNext(parent);

      const after = await getTemplate(t.id);
      assert.equal(after?.status, 'paused', 'template should be auto-paused');

      const childCount = await pool.query(
        `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(childCount.rows.length, 0, 'failed parent must not spawn child');

      const audit = await pool.query<{ details: { reason: string; failedJobId: number; from: string; to: string } }>(
        `SELECT details FROM admin_audit_log
           WHERE action = 'batch_template_status' AND target_id = $1
           ORDER BY id DESC LIMIT 1`,
        [t.id],
      );
      assert.ok(audit.rows.length > 0, 'a status-change audit row should exist');
      const det = audit.rows[0].details;
      assert.equal(det.reason, 'auto_paused_on_failure');
      assert.equal(det.failedJobId, Number(parent.id), 'audit must include failed job id');
      assert.equal(det.from, 'active');
      assert.equal(det.to, 'paused');
    } finally {
      await cleanup([t.id]);
    }
  });

  it('missing template (deleted mid-chain) → no error, no spawn', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    // simulate template removal between finalize and spawn
    await cleanup([t.id]);

    // run with stale row pointing at the just-deleted template id
    await maybeSpawnNext(parent); // should not throw

    const r = await pool.query(
      `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
      [parent.id],
    );
    assert.equal(r.rows.length, 0, 'missing template must not spawn');
    // generation_jobs row still exists (with template_id NULLed by FK SET NULL) —
    // remove it to keep the table tidy.
    await pool.query(`DELETE FROM generation_jobs WHERE id = $1`, [parent.id]);
  });

  it('ad-hoc job (template_id NULL) → early return, no spawn attempted', async () => {
    // ad-hoc: no template, just a plain finalized job
    const parent = await makeFinalizedJob(null, 'completed');
    try {
      await maybeSpawnNext(parent); // must early-return without DB writes

      const childCount = await pool.query(
        `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(childCount.rows.length, 0, 'ad-hoc finalize must not spawn');
    } finally {
      await pool.query(`DELETE FROM generation_jobs WHERE id = $1`, [parent.id]);
    }
  });

  it('race: two concurrent finalize calls with same parent → exactly one child', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      await Promise.all([maybeSpawnNext(parent), maybeSpawnNext(parent)]);

      const r = await pool.query<{ id: string }>(
        `SELECT id FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(r.rows.length, 1, 'unique index must allow exactly one child');
    } finally {
      await cleanup([t.id]);
    }
  });

  it('duplicate sequential finalize → second is a no-op (idempotency)', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      await maybeSpawnNext(parent);
      await maybeSpawnNext(parent); // should not duplicate

      const r = await pool.query(
        `SELECT id FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(r.rows.length, 1, 'second sequential call must not insert another child');
    } finally {
      await cleanup([t.id]);
    }
  });

  it('paused mid-chain: finalize after pause → no spawn even if status was active when batch started', async () => {
    const t = await makeTemplate({ status: 'active', cooldownSeconds: 0 });
    const parent = await makeFinalizedJob(t.id, 'completed');
    try {
      // operator pauses while the batch is running. By the time finalize fires,
      // status is 'paused'.
      await setTemplateStatus(t.id, 'paused', SYS_CTX);
      await maybeSpawnNext(parent);

      const r = await pool.query(
        `SELECT 1 FROM generation_jobs WHERE parent_job_id = $1`,
        [parent.id],
      );
      assert.equal(r.rows.length, 0, 'pause-mid-chain must stop the chain at next finalize');
    } finally {
      await cleanup([t.id]);
    }
  });

  after(async () => {
    // bullmq Worker connection و pool رو ببند تا process cleanly exit کنه
    await templateChainQueue.close();
    await closePool();
    await closeRedis();
  });
});
