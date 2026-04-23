/**
 * Wallet routes:
 *   GET  /api/wallets              — list with filter/pagination
 *   GET  /api/wallets/:id          — detail with addresses
 *   POST /api/wallets              — create new wallet for user
 *   POST /api/wallets/:id/addresses — generate new deposit address
 *   POST /api/wallets/:id/reveal   — reveal mnemonic (super_admin only)
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import {
  createWallet,
  importWallet,
  getNewDepositAddress,
  revealMnemonic,
  WalletNotFoundError,
  InvalidMnemonicError,
} from '../../services/wallet-service.js';
import type { Chain } from '../../wallet/derivation.js';
import { sanitizeAuditDetails } from '../../util/sanitize.js';

export default async function walletRoutes(fastify: FastifyInstance) {
  const authed = [fastify.requireAuth, fastify.requireNotMustChange];
  const superAdminOnly = [
    fastify.requireAuth,
    fastify.requireNotMustChange,
    fastify.requireRole('super_admin'),
  ];

  // GET /
  fastify.get<{
    Querystring: { word_count?: string; user_id?: string; page?: string; per_page?: string };
  }>('/', { preHandler: authed }, async (req) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 20));
    const offset = (page - 1) * perPage;

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (req.query.word_count) {
      const wc = Number(req.query.word_count);
      if (wc === 12 || wc === 24) {
        conditions.push(`w.word_count = $${p++}`);
        params.push(wc);
      }
    }
    if (req.query.user_id) {
      conditions.push(`w.user_id = $${p++}`);
      params.push(Number(req.query.user_id));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM wallets w ${where}`,
      params
    );
    const listRes = await pool.query(
      `SELECT w.id, w.user_id, w.word_count, w.created_at,
              w.next_index_btc, w.next_index_eth, w.next_index_tron,
              (SELECT COUNT(*) FROM addresses a WHERE a.wallet_id = w.id) AS address_count
       FROM wallets w ${where}
       ORDER BY w.id DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, perPage, offset]
    );

    return {
      wallets: listRes.rows,
      pagination: {
        page,
        per_page: perPage,
        total: countRes.rows[0].total,
        total_pages: Math.ceil(countRes.rows[0].total / perPage),
      },
    };
  });

  // GET /:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: authed },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const walletRes = await pool.query(
        `SELECT id, user_id, word_count, created_at,
                next_index_btc, next_index_eth, next_index_tron
         FROM wallets WHERE id = $1`,
        [id]
      );
      if (walletRes.rows.length === 0) {
        return reply.code(404).send({ error: 'not found' });
      }
      const addrRes = await pool.query(
        `SELECT id, chain, derivation_index, derivation_path, address,
                native_balance, usdt_balance, priority, last_checked_at,
                tx_count, status, created_at
         FROM addresses WHERE wallet_id = $1
         ORDER BY chain, derivation_index`,
        [id]
      );
      return { wallet: walletRes.rows[0], addresses: addrRes.rows };
    }
  );

  // POST / (create wallet)
  fastify.post<{
    Body: { user_id: number; word_count?: 12 | 24; initial_address_count?: number };
  }>(
    '/',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['user_id'],
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            word_count: { type: 'integer', enum: [12, 24] },
            initial_address_count: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await createWallet({
          userId: req.body.user_id,
          wordCount: req.body.word_count ?? 12,
          initialAddressCount: req.body.initial_address_count ?? 1,
        });
        await pool.query(
          `INSERT INTO admin_audit_log
             (admin_id, action, target_type, target_id, success, details, ip_address)
           VALUES ($1, 'create_wallet', 'wallet', $2, true, $3, $4)`,
          [
            req.admin!.sub,
            result.walletId,
            sanitizeAuditDetails({ user_id: req.body.user_id }),
            req.ip,
          ]
        );
        return { wallet_id: result.walletId, addresses: result.addresses };
      } catch (e: any) {
        if (e.code === '23505') {
          return reply.code(409).send({ error: 'این user_id قبلاً ولت داره' });
        }
        throw e;
      }
    }
  );

  // POST /import (import existing wallet from user-provided mnemonic)
  fastify.post<{
    Body: {
      user_id: number;
      mnemonic: string;
      initial_address_count?: number;
      scan_legacy_btc?: boolean;
    };
  }>(
    '/import',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'mnemonic'],
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            mnemonic: { type: 'string', minLength: 1, maxLength: 1000 },
            initial_address_count: { type: 'integer', minimum: 1, maximum: 100 },
            scan_legacy_btc: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await importWallet({
          userId: req.body.user_id,
          mnemonic: req.body.mnemonic,
          initialAddressCount: req.body.initial_address_count ?? 1,
          scanLegacyBtc: req.body.scan_legacy_btc ?? true,
        });
        await pool.query(
          `INSERT INTO admin_audit_log
             (admin_id, action, target_type, target_id, success, details, ip_address)
           VALUES ($1, 'import_wallet', 'wallet', $2, true, $3, $4)`,
          [
            req.admin!.sub,
            result.walletId,
            sanitizeAuditDetails({
              user_id: req.body.user_id,
              legacy_btc_detected: result.legacyBtc.detected.length,
              legacy_btc_scanned: result.legacyBtc.scanned,
            }),
            req.ip,
          ]
        );
        return {
          wallet_id: result.walletId,
          addresses: result.addresses,
          legacy_btc: {
            scanned: result.legacyBtc.scanned,
            detected: result.legacyBtc.detected.map((a) => ({
              chain: a.chain,
              index: a.index,
              path: a.path,
              address: a.address,
              address_type: a.btcAddressType,
            })),
            skipped: result.legacyBtc.skipped ?? false,
          },
        };
      } catch (e: any) {
        if (e instanceof InvalidMnemonicError) {
          return reply.code(e.statusCode).send({ error: e.code, message: e.message });
        }
        if (e.code === '23505') {
          return reply.code(409).send({ error: 'این user_id قبلاً ولت داره' });
        }
        throw e;
      }
    }
  );

  // POST /:id/addresses (new deposit address)
  fastify.post<{
    Params: { id: string };
    Body: { chain: Chain };
  }>(
    '/:id/addresses',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['chain'],
          properties: { chain: { type: 'string', enum: ['BTC', 'ETH', 'TRON'] } },
        },
      },
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      try {
        const addr = await getNewDepositAddress(id, req.body.chain);
        return { address: addr };
      } catch (e) {
        if (e instanceof WalletNotFoundError) {
          return reply.code(404).send({ error: e.code });
        }
        throw e;
      }
    }
  );

  // POST /:id/reveal (super_admin only)
  fastify.post<{
    Params: { id: string };
  }>(
    '/:id/reveal',
    {
      preHandler: superAdminOnly,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const ua = req.headers['user-agent'] ?? null;
      const adminId = req.admin!.sub;

      try {
        const mnemonic = await revealMnemonic(id);
        await pool.query(
          `INSERT INTO admin_audit_log
             (admin_id, action, target_type, target_id, success, ip_address, user_agent)
           VALUES ($1, 'reveal_mnemonic', 'wallet', $2, true, $3, $4)`,
          [adminId, id, req.ip, ua]
        );
        await pool.query(
          `INSERT INTO mnemonic_access_log
             (wallet_id, admin_id, success, ip_address, user_agent)
           VALUES ($1, $2, true, $3, $4)`,
          [id, adminId, req.ip, ua]
        );
        return { mnemonic };
      } catch (e) {
        await pool.query(
          `INSERT INTO mnemonic_access_log
             (wallet_id, admin_id, success, ip_address, user_agent)
           VALUES ($1, $2, false, $3, $4)`,
          [id, adminId, req.ip, ua]
        );
        if (e instanceof WalletNotFoundError) {
          return reply.code(404).send({ error: e.code });
        }
        throw e;
      }
    }
  );
}
