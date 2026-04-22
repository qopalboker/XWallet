/**
 * Authentication facade:
 *   - re-exports password & JWT utilities
 *   - Fastify middleware (authGuard, requireNotMustChange, requireRole)
 *   - decorator registration helper
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type TokenPayload, type AdminRole } from './jwt.js';

export * from './passwords.js';
export * from './jwt.js';

export const COOKIE_NAME = 'admin_token';

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 60 * 60 * 8,
};

declare module 'fastify' {
  interface FastifyRequest {
    admin?: TokenPayload;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireNotMustChange: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: AdminRole) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = request.cookies[COOKIE_NAME];

  if (!token) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }

  try {
    const payload = await verifyToken(token);
    request.admin = payload;
  } catch {
    void reply.clearCookie(COOKIE_NAME, { path: '/' });
    await reply.code(401).send({ error: 'invalid_token' });
  }
}

export async function requireNotMustChange(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (request.admin?.mustChangePassword) {
    await reply.code(403).send({
      error: 'must_change_password',
      message: 'باید اول رمز پیش‌فرض رو عوض کنی',
    });
  }
}

export function requireRole(role: AdminRole) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.admin?.role !== role) {
      await reply.code(403).send({ error: 'forbidden' });
    }
  };
}

export function registerAuthDecorators(app: FastifyInstance): void {
  app.decorate('requireAuth', authGuard);
  app.decorate('requireNotMustChange', requireNotMustChange);
  app.decorate('requireRole', requireRole);
}
