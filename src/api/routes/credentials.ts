/**
 * API Credentials management routes:
 *   GET    /api/credentials                      - لیست همه (با masked value)
 *   POST   /api/credentials                      - اضافه کردن توکن جدید
 *   DELETE /api/credentials/:id                  - حذف
 *   POST   /api/credentials/:id/toggle           - فعال/غیرفعال
 *   POST   /api/credentials/:id/unblock          - آزاد کردن rate limit
 *   POST   /api/credentials/:id/benchmark        - toggle benchmark_allowed
 *   POST   /api/credentials/getblock/import      - import یکجا از GetBlock JSON
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import {
  listCredentials,
  addCredential,
  deleteCredential,
  setActive,
  clearRateLimit,
  setBenchmarkAllowed,
  type Provider,
} from '../../services/credentials-service.js';
import { importGetBlockConfig } from '../../services/getblock.js';

const VALID_PROVIDERS: Provider[] = ['trongrid', 'eth_rpc', 'btc_api'];

export async function credentialRoutes(app: FastifyInstance) {
  const authed = [app.requireAuth, app.requireNotMustChange];

  // ─── GET /api/credentials ───
  app.get<{ Querystring: { provider?: string } }>(
    '/api/credentials',
    { preHandler: authed },
    async (request) => {
      const provider = request.query.provider as Provider | undefined;
      if (provider && !VALID_PROVIDERS.includes(provider)) {
        return { items: [] };
      }
      const items = await listCredentials(provider);
      return { items };
    }
  );

  // ─── POST /api/credentials ───
  app.post<{
    Body: { provider: Provider; value: string; label?: string };
  }>(
    '/api/credentials',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['provider', 'value'],
          properties: {
            provider: { type: 'string', enum: VALID_PROVIDERS },
            value: { type: 'string', minLength: 1, maxLength: 2000 },
            label: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { provider, value, label } = request.body;
      const id = await addCredential({
        provider,
        value: value.trim(),
        label,
        adminId: request.admin!.sub,
      });
      return reply.code(201).send({ id });
    }
  );

  // ─── DELETE /api/credentials/:id ───
  app.delete<{ Params: { id: string } }>(
    '/api/credentials/:id',
    { preHandler: authed },
    async (request) => {
      await deleteCredential(Number(request.params.id));
      return { ok: true };
    }
  );

  // ─── POST /api/credentials/:id/toggle ───
  app.post<{ Params: { id: string }; Body: { active: boolean } }>(
    '/api/credentials/:id/toggle',
    { preHandler: authed },
    async (request) => {
      await setActive(Number(request.params.id), request.body.active);
      return { ok: true };
    }
  );

  // ─── POST /api/credentials/:id/unblock ───
  app.post<{ Params: { id: string } }>(
    '/api/credentials/:id/unblock',
    { preHandler: authed },
    async (request) => {
      await clearRateLimit(Number(request.params.id));
      return { ok: true };
    }
  );

  // ─── POST /api/credentials/:id/benchmark ───
  app.post<{ Params: { id: string }; Body: { allowed: boolean } }>(
    '/api/credentials/:id/benchmark',
    { preHandler: authed },
    async (request) => {
      await setBenchmarkAllowed(Number(request.params.id), !!request.body.allowed);
      return { ok: true };
    }
  );

  // ─── POST /api/credentials/getblock/import ───
  // ادمین JSON داشبورد GetBlock رو پیست می‌کنه و یکجا وارد credentials
  // می‌شه. Token ها هرگز تو log یا audit ذخیره نمی‌شن — فقط شمارش.
  app.post<{
    Body: { config: string | object; skipExisting?: boolean };
  }>(
    '/api/credentials/getblock/import',
    {
      preHandler: authed,
      schema: {
        body: {
          type: 'object',
          required: ['config'],
          properties: {
            // config می‌تونه string (JSON) یا object باشه
            config: {
              anyOf: [{ type: 'string', maxLength: 200_000 }, { type: 'object' }],
            },
            skipExisting: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { config, skipExisting = true } = request.body;
      const adminId = request.admin!.sub;

      let result;
      try {
        result = await importGetBlockConfig(config, { adminId, skipExisting });
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }

      // Audit log — هیچ توکن یا URLی ذخیره نمی‌شه، فقط شمارش‌ها
      await pool.query(
        `INSERT INTO admin_audit_log
           (admin_id, action, success, details, ip_address, user_agent)
         VALUES ($1, 'getblock_import', true, $2, $3, $4)`,
        [
          adminId,
          JSON.stringify({
            added: result.added,
            skipped: result.skipped,
            skippedBtc: result.skippedBtc,
            invalidCount: result.invalid.length,
          }),
          request.ip,
          request.headers['user-agent'] ?? null,
        ]
      );

      return reply.send(result);
    }
  );
}
