/**
 * API Credentials management routes:
 *   GET    /api/credentials            - لیست همه (با masked value)
 *   POST   /api/credentials            - اضافه کردن توکن جدید
 *   DELETE /api/credentials/:id        - حذف
 *   POST   /api/credentials/:id/toggle - فعال/غیرفعال
 *   POST   /api/credentials/:id/unblock - آزاد کردن rate limit
 */

import type { FastifyInstance } from 'fastify';
import {
  listCredentials,
  addCredential,
  deleteCredential,
  setActive,
  clearRateLimit,
  type Provider,
} from '../../services/credentials-service.js';

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
}
