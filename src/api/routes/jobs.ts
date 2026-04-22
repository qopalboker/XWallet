/**
 * Jobs management API:
 *   GET    /api/jobs           - لیست generation jobs (با pagination)
 *   GET    /api/jobs/:id       - جزئیات یه job
 *   POST   /api/jobs/generate  - job جدید batch generation بساز
 *   POST   /api/jobs/balance-now - یه balance check فوری trigger کن
 *   GET    /api/queue-stats    - آمار صف‌ها
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { generationQueue, balanceQueue } from '../../queue/queues.js';

export async function jobRoutes(app: FastifyInstance) {
  const authed = [app.requireAuth, app.requireNotMustChange];

  // ─── GET /api/jobs ───
  app.get<{
    Querystring: { page?: number; limit?: number; status?: string };
  }>('/api/jobs', { preHandler: authed }, async (request) => {
    const page = Math.max(1, Number(request.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20)));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: unknown[] = [];
    if (request.query.status) {
      params.push(request.query.status);
      where.push(`status = $${params.length}`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT id, requested_by, word_count, total_count, completed, status,
              started_at, completed_at, created_at,
              CASE WHEN LENGTH(error) > 200 THEN LEFT(error, 200) || '...' ELSE error END AS error
       FROM generation_jobs ${whereClause}
       ORDER BY id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const count = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM generation_jobs ${whereClause}`,
      params.slice(0, params.length - 2)
    );

    return { items: rows.rows, total: Number(count.rows[0].total), page, limit };
  });

  // ─── GET /api/jobs/:id ───
  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
    { preHandler: authed },
    async (request, reply) => {
      const id = Number(request.params.id);
      const res = await pool.query(
        `SELECT * FROM generation_jobs WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return reply.code(404).send({ error: 'not found' });
      return res.rows[0];
    }
  );

  // ─── POST /api/jobs/generate ───
  app.post<{
    Body: {
      count: number;
      wordCount?: 12 | 24;
      addressesPerWallet?: number;
      startUserId?: number;
    };
  }>(
    '/api/jobs/generate',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['count'],
          properties: {
            count: { type: 'integer', minimum: 1, maximum: 100_000 },
            wordCount: { type: 'integer', enum: [12, 24] },
            addressesPerWallet: { type: 'integer', minimum: 1, maximum: 20 },
            startUserId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        count,
        wordCount = 12,
        addressesPerWallet = 1,
        startUserId,
      } = request.body;

      let start = startUserId;
      if (!start) {
        const r = await pool.query<{ next: string }>(
          `SELECT COALESCE(MAX(user_id), 0) + 1 AS next FROM wallets`
        );
        start = Number(r.rows[0].next);
      }

      const overlap = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM wallets
         WHERE user_id >= $1 AND user_id < $2`,
        [start, start + count]
      );
      if (Number(overlap.rows[0].cnt) > 0) {
        return reply.code(409).send({
          error: `user_id از ${start} تا ${start + count - 1} قبلاً استفاده شده`,
        });
      }

      const dbRes = await pool.query<{ id: number }>(
        `INSERT INTO generation_jobs
         (requested_by, word_count, total_count, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id`,
        [request.admin!.sub, wordCount, count]
      );
      const jobDbId = dbRes.rows[0].id;

      const bullJob = await generationQueue.add('generate', {
        jobDbId,
        startUserId: start,
        count,
        wordCount,
        addressesPerWallet,
      });

      return reply.code(201).send({
        jobDbId,
        bullJobId: bullJob.id,
        startUserId: start,
        count,
      });
    }
  );

  // ─── POST /api/jobs/balance-now ───
  app.post<{ Body: { priority?: 'active' | 'normal' | 'inactive' } }>(
    '/api/jobs/balance-now',
    { preHandler: authed },
    async (request) => {
      const priority = request.body?.priority ?? 'active';
      const job = await balanceQueue.add('manual-check', { priority, batchSize: 500 });
      return { ok: true, bullJobId: job.id };
    }
  );

  // ─── GET /api/queue-stats ───
  app.get('/api/queue-stats', { preHandler: authed }, async () => {
    const [genWaiting, genActive, genDone, genFailed] = await Promise.all([
      generationQueue.getWaitingCount(),
      generationQueue.getActiveCount(),
      generationQueue.getCompletedCount(),
      generationQueue.getFailedCount(),
    ]);
    const [balWaiting, balActive, balDone, balFailed] = await Promise.all([
      balanceQueue.getWaitingCount(),
      balanceQueue.getActiveCount(),
      balanceQueue.getCompletedCount(),
      balanceQueue.getFailedCount(),
    ]);

    return {
      generation: { waiting: genWaiting, active: genActive, completed: genDone, failed: genFailed },
      balance: { waiting: balWaiting, active: balActive, completed: balDone, failed: balFailed },
    };
  });
}
