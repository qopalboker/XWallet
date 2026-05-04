/**
 * Batch templates REST API:
 *   GET    /api/batch-templates           — لیست
 *   POST   /api/batch-templates           — ساخت (super_admin)
 *   PATCH  /api/batch-templates/:id       — ویرایش (super_admin)
 *   DELETE /api/batch-templates/:id       — حذف (super_admin)
 *   POST   /api/batch-templates/:id/run   — اجرای دستی (super_admin، idempotent)
 *
 *   GET    /api/system/auto-batch         — وضعیت circuit breaker
 *   PUT    /api/system/auto-batch         — toggle circuit breaker (super_admin)
 *
 * audit log همه‌ی mutation ها در سرویس انجام می‌شه.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  runTemplate,
  isAutoBatchEnabled,
  setAutoBatchEnabled,
  TemplateValidationError,
  RunBlockedError,
  type AuditCtx,
} from '../../services/batch-templates-service.js';

function ctxFrom(req: FastifyRequest): AuditCtx {
  // username تو JWT payload نیست — برای audit denorm فقط admin_id رو نگه می‌داریم.
  return {
    adminId: req.admin?.sub ?? null,
    username: null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export async function batchTemplateRoutes(app: FastifyInstance): Promise<void> {
  const authed = [app.requireAuth, app.requireNotMustChange];
  const superOnly = [app.requireAuth, app.requireNotMustChange, app.requireRole('super_admin')];

  // ─── GET /api/batch-templates ───
  app.get('/api/batch-templates', { preHandler: authed }, async () => {
    const items = await listTemplates();
    return { items };
  });

  // ─── POST /api/batch-templates ───
  app.post<{
    Body: {
      name: string;
      enabled?: boolean;
      spec: unknown;
      triggerType: unknown;
      cronExpr?: unknown;
      cooldownHours?: number | null;
    };
  }>(
    '/api/batch-templates',
    {
      preHandler: superOnly,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'spec', 'triggerType'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            enabled: { type: 'boolean' },
            spec: { type: 'object' },
            triggerType: { type: 'string', enum: ['on_startup', 'cron', 'manual'] },
            cronExpr: { type: 'string', maxLength: 100, nullable: true },
            cooldownHours: { type: 'integer', minimum: 0, nullable: true },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const t = await createTemplate(req.body, ctxFrom(req));
        return reply.code(201).send(t);
      } catch (e) {
        if (e instanceof TemplateValidationError) {
          return reply.code(400).send({ error: e.message });
        }
        throw e;
      }
    }
  );

  // ─── PATCH /api/batch-templates/:id ───
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      enabled?: boolean;
      spec?: unknown;
      triggerType?: unknown;
      cronExpr?: unknown;
      cooldownHours?: number | null;
    };
  }>(
    '/api/batch-templates/:id',
    { preHandler: superOnly },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      try {
        const t = await updateTemplate(id, req.body, ctxFrom(req));
        if (!t) return reply.code(404).send({ error: 'not found' });
        return t;
      } catch (e) {
        if (e instanceof TemplateValidationError) {
          return reply.code(400).send({ error: e.message });
        }
        throw e;
      }
    }
  );

  // ─── DELETE /api/batch-templates/:id ───
  app.delete<{ Params: { id: string } }>(
    '/api/batch-templates/:id',
    { preHandler: superOnly },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const ok = await deleteTemplate(id, ctxFrom(req));
      if (!ok) return reply.code(404).send({ error: 'not found' });
      return reply.code(204).send();
    }
  );

  // ─── POST /api/batch-templates/:id/run ───
  app.post<{ Params: { id: string } }>(
    '/api/batch-templates/:id/run',
    { preHandler: superOnly },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      try {
        const result = await runTemplate(id, 'manual', ctxFrom(req));
        return reply.code(result.reused ? 200 : 201).send(result);
      } catch (e) {
        if (e instanceof RunBlockedError) {
          return reply.code(e.statusCode).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    }
  );

  // ─── system circuit breaker ───
  // فقط super_admin می‌تونه ببینه و toggle کنه (تنظیم حساس).
  app.get('/api/system/auto-batch', { preHandler: superOnly }, async () => {
    const s = await isAutoBatchEnabled();
    return s;
  });

  app.put<{ Body: { enabled: boolean } }>(
    '/api/system/auto-batch',
    {
      preHandler: superOnly,
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      // اگه env override ست شده، DB رو تغییر بدیم بی‌اثره. به کاربر هشدار می‌دیم.
      const before = await isAutoBatchEnabled();
      if (before.source === 'env') {
        return reply.code(409).send({
          error: `AUTO_BATCH_ENABLED از طریق env کنترل می‌شه (مقدار="${process.env.AUTO_BATCH_ENABLED}"). اول env رو unset کن.`,
          code: 'env_override',
        });
      }
      await setAutoBatchEnabled(req.body.enabled, ctxFrom(req));
      return await isAutoBatchEnabled();
    }
  );
}
