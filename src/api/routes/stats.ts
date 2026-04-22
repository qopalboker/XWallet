/**
 * Stats API:
 *   GET /api/stats  - آمار کلی داشبورد
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';

export async function statsRoutes(app: FastifyInstance) {
  const authed = [app.requireAuth, app.requireNotMustChange];

  app.get('/api/stats', { preHandler: authed }, async () => {
    const [wallets, addresses, balances, jobs, benchmarks] = await Promise.all([
      pool.query<{ total: string; words12: string; words24: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE word_count = 12)::text AS words12,
                COUNT(*) FILTER (WHERE word_count = 24)::text AS words24
         FROM wallets`
      ),
      pool.query<{ total: string; btc: string; eth: string; tron: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE chain = 'BTC')::text AS btc,
                COUNT(*) FILTER (WHERE chain = 'ETH')::text AS eth,
                COUNT(*) FILTER (WHERE chain = 'TRON')::text AS tron
         FROM addresses WHERE status = 'active'`
      ),
      pool.query<{
        chain: string;
        count: string;
        native_sum: string;
        usdt_sum: string;
      }>(
        `SELECT chain,
                COUNT(*) FILTER (WHERE native_balance > 0 OR usdt_balance > 0)::text AS count,
                COALESCE(SUM(native_balance), 0)::text AS native_sum,
                COALESCE(SUM(usdt_balance), 0)::text AS usdt_sum
         FROM addresses WHERE status = 'active'
         GROUP BY chain`
      ),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count
         FROM generation_jobs
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY status`
      ),
      pool.query<{ total: string; running: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status = 'running')::text AS running
         FROM benchmark_runs`
      ),
    ]);

    const balanceMap: Record<string, { count: number; native: string; usdt: string }> = {};
    for (const row of balances.rows) {
      balanceMap[row.chain] = {
        count: Number(row.count),
        native: row.native_sum,
        usdt: row.usdt_sum,
      };
    }

    const jobsMap: Record<string, number> = {};
    for (const row of jobs.rows) jobsMap[row.status] = Number(row.count);

    return {
      wallets: {
        total: Number(wallets.rows[0].total),
        words12: Number(wallets.rows[0].words12),
        words24: Number(wallets.rows[0].words24),
      },
      addresses: {
        total: Number(addresses.rows[0].total),
        btc: Number(addresses.rows[0].btc),
        eth: Number(addresses.rows[0].eth),
        tron: Number(addresses.rows[0].tron),
      },
      balances: balanceMap,
      jobs: jobsMap,
      benchmarks: {
        total: Number(benchmarks.rows[0].total),
        running: Number(benchmarks.rows[0].running),
      },
    };
  });
}
