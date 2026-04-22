/**
 * Benchmark API:
 *   GET    /api/benchmark/current       - run فعلی (اگه باشه) + آمار live
 *   GET    /api/benchmark/runs          - تاریخچه run ها
 *   GET    /api/benchmark/runs/:id      - جزئیات یه run
 *   POST   /api/benchmark/start         - شروع run جدید
 *   POST   /api/benchmark/stop          - توقف run فعلی
 *   GET    /api/benchmark/math          - آمار آموزشی (فضای جستجو و غیره)
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import {
  startBenchmark,
  requestStop,
  getCurrentRunId,
  MAX_TARGET,
} from '../../services/benchmark-service.js';
import type { Chain } from '../../wallet/derivation.js';

export async function benchmarkRoutes(app: FastifyInstance) {
  const authed = [app.requireAuth, app.requireNotMustChange];

  // ─── GET /api/benchmark/current ───
  app.get('/api/benchmark/current', { preHandler: authed }, async () => {
    const runId = getCurrentRunId();
    if (!runId) return { running: false };

    const res = await pool.query(
      `SELECT id, word_count, addresses_per_mnemonic, target_count, chains,
              checked_count, hit_count, hits_info,
              avg_rate_per_sec, status, started_at
       FROM benchmark_runs WHERE id = $1`,
      [runId]
    );
    if (res.rows.length === 0) return { running: false };

    return { running: true, run: res.rows[0] };
  });

  // ─── GET /api/benchmark/runs ───
  app.get<{ Querystring: { limit?: number } }>(
    '/api/benchmark/runs',
    { preHandler: authed },
    async (request) => {
      const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20)));
      const res = await pool.query(
        `SELECT id, word_count, target_count, chains,
                checked_count, hit_count, status,
                started_at, completed_at, duration_ms, avg_rate_per_sec
         FROM benchmark_runs
         ORDER BY id DESC
         LIMIT $1`,
        [limit]
      );
      return { items: res.rows };
    }
  );

  // ─── GET /api/benchmark/runs/:id ───
  app.get<{ Params: { id: string } }>(
    '/api/benchmark/runs/:id',
    { preHandler: authed },
    async (request, reply) => {
      const res = await pool.query(
        `SELECT * FROM benchmark_runs WHERE id = $1`,
        [Number(request.params.id)]
      );
      if (res.rows.length === 0) return reply.code(404).send({ error: 'not found' });
      return res.rows[0];
    }
  );

  // ─── POST /api/benchmark/start ───
  app.post<{
    Body: {
      targetCount: number;
      wordCount?: 12 | 24;
      addressesPerMnemonic?: number;
      chains?: Chain[];
    };
  }>(
    '/api/benchmark/start',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['targetCount'],
          properties: {
            targetCount: { type: 'integer', minimum: 1, maximum: MAX_TARGET },
            wordCount: { type: 'integer', enum: [12, 24] },
            addressesPerMnemonic: { type: 'integer', minimum: 1, maximum: 10 },
            chains: {
              type: 'array',
              items: { type: 'string', enum: ['BTC', 'ETH', 'TRON'] },
              minItems: 1,
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const runId = await startBenchmark({
          targetCount: request.body.targetCount,
          wordCount: request.body.wordCount ?? 12,
          addressesPerMnemonic: request.body.addressesPerMnemonic ?? 3,
          chains: request.body.chains ?? ['BTC', 'ETH', 'TRON'],
          adminId: request.admin!.sub,
        });
        return reply.code(201).send({ runId, maxTarget: MAX_TARGET });
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );

  // ─── POST /api/benchmark/stop ───
  app.post('/api/benchmark/stop', { preHandler: authed }, async () => {
    await requestStop();
    return { ok: true };
  });

  // ─── GET /api/benchmark/math ───
  // محاسبات آموزشی — این endpoint عمدا عمومیه (auth لازم نداره)
  app.get('/api/benchmark/math', async () => {
    return {
      maxTarget: MAX_TARGET,
      searchSpace12Words: '2^128 ≈ 3.4 × 10^38',
      searchSpace24Words: '2^256 ≈ 1.16 × 10^77',
      atomsInUniverse: '~10^80',
      secondsSinceBigBang: '~4.35 × 10^17',
      explanation: {
        fa: 'فضای جستجوی ۱۲ کلمه‌ای ≈ 10^38. اگه کل کامپیوترهای دنیا (10^18 عملیات در ثانیه) از ابتدای کائنات در حال جستجو بودن، تا الان فقط 10^35 ترکیب رو تست کرده بودن — هنوز ۰.۰۰۰۰۰۱٪ فضای جستجو رو پوشش ندادن.',
        en: 'The 12-word search space is about 10^38. If every computer on Earth (10^18 ops/sec) had been brute-forcing since the Big Bang, they would have covered only 10^35 combinations — still just 0.00001% of the search space.',
      },
      probabilityForMaxTarget: {
        value: `≈ ${MAX_TARGET} / 2^128 ≈ 3 × 10^-34`,
        comparison: 'احتمال این که یه بار پرتاب سکه، ۱۱۰ بار پشت سر هم شیر بیاد',
      },
    };
  });
}
