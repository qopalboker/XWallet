/**
 * Test/debug routes:
 *   POST /api/test/wallet-flow — dry-run a mnemonic through the production
 *     derivation + balance pipeline. No DB writes, no addresses persisted,
 *     so results never appear in the Funded Wallets list. super_admin only.
 */

import type { FastifyInstance } from 'fastify';
import {
  normalizeMnemonic,
  isValidMnemonic,
  deriveBtcAllTypes,
  deriveMany,
  type DerivedAddress,
} from '../../wallet/derivation.js';
import { fetchBalancesByChain } from '../../balance/cache.js';

interface BalancePerAddr {
  index: number;
  path: string;
  address: string;
  btc_address_type?: string;
  native: string;
  usdt: string | null;
  fetched: boolean;
}

interface Step {
  step: 'normalize' | 'derive' | 'balance_fetch';
  ok: boolean;
  duration_ms: number;
  details?: Record<string, unknown>;
  error?: string;
}

export async function testRoutes(fastify: FastifyInstance) {
  const superAdminOnly = [
    fastify.requireAuth,
    fastify.requireNotMustChange,
    fastify.requireRole('super_admin'),
  ];

  fastify.post<{
    Body: { mnemonic: string; address_count?: number };
  }>(
    '/api/test/wallet-flow',
    {
      preHandler: superAdminOnly,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['mnemonic'],
          properties: {
            mnemonic: { type: 'string', minLength: 1, maxLength: 1000 },
            address_count: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const steps: Step[] = [];
      const addressCount = req.body.address_count ?? 5;

      // ── Step 1: normalize + validate
      const t0 = Date.now();
      const normalized = normalizeMnemonic(req.body.mnemonic);
      const wordCount = normalized.split(' ').length;
      const valid = isValidMnemonic(normalized);
      steps.push({
        step: 'normalize',
        ok: valid,
        duration_ms: Date.now() - t0,
        details: { word_count: wordCount, valid },
      });
      if (!valid) {
        return reply.code(400).send({
          steps,
          error: wordCount === 12 || wordCount === 24
            ? 'invalid mnemonic checksum'
            : `unsupported word count: ${wordCount} (expected 12 or 24)`,
        });
      }

      // ── Step 2: derive (BTC: all 3 types × N; TRON: N). ETH intentionally excluded.
      const t1 = Date.now();
      let derived: { btc: DerivedAddress[]; tron: DerivedAddress[] };
      try {
        const [btc, tron] = await Promise.all([
          deriveBtcAllTypes(normalized, 0, addressCount),
          deriveMany(normalized, [{ chain: 'TRON', fromIndex: 0, count: addressCount }]),
        ]);
        derived = { btc, tron };
      } catch (e) {
        steps.push({
          step: 'derive',
          ok: false,
          duration_ms: Date.now() - t1,
          error: (e as Error).message,
        });
        return reply.code(500).send({ steps, error: 'derivation failed' });
      }
      steps.push({
        step: 'derive',
        ok: true,
        duration_ms: Date.now() - t1,
        details: {
          btc_count: derived.btc.length,
          tron_count: derived.tron.length,
        },
      });

      // ── Step 3: balance fetch (same code path as the worker)
      const t2 = Date.now();
      const fetched = await fetchBalancesByChain(
        derived.btc.map((d) => d.address),
        [],
        derived.tron.map((d) => d.address)
      ).catch((e) => {
        steps.push({
          step: 'balance_fetch',
          ok: false,
          duration_ms: Date.now() - t2,
          error: (e as Error).message,
        });
        return null;
      });
      if (!fetched) {
        return reply.code(502).send({ steps, error: 'balance fetch failed' });
      }
      steps.push({
        step: 'balance_fetch',
        ok: true,
        duration_ms: Date.now() - t2,
        details: {
          btc_resolved: fetched.btc.size,
          tron_resolved: fetched.tron.size,
        },
      });

      // ── Build per-address result rows
      const btcRows: BalancePerAddr[] = derived.btc.map((d) => {
        const b = fetched.btc.get(d.address);
        return {
          index: d.index,
          path: d.path,
          address: d.address,
          btc_address_type: d.btcAddressType,
          native: b ? b.sats.toString() : '0',
          usdt: null,
          fetched: !!b,
        };
      });
      const tronRows: BalancePerAddr[] = derived.tron.map((d) => {
        const b = fetched.tron.get(d.address);
        return {
          index: d.index,
          path: d.path,
          address: d.address,
          native: b ? b.trx.toString() : '0',
          usdt: b ? b.usdt.toString() : '0',
          fetched: !!b,
        };
      });

      // ── Per-chain totals (BigInt-safe via string addition through bigint)
      const sumBig = (vals: string[]) =>
        vals.reduce((acc, v) => acc + BigInt(v || '0'), 0n).toString();

      return {
        steps,
        word_count: wordCount,
        address_count: addressCount,
        addresses: { BTC: btcRows, TRON: tronRows },
        totals: {
          BTC: { native: sumBig(btcRows.map((r) => r.native)) },
          TRON: {
            native: sumBig(tronRows.map((r) => r.native)),
            usdt: sumBig(tronRows.map((r) => r.usdt ?? '0')),
          },
        },
      };
    }
  );
}
