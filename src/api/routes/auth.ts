/**
 * Auth routes:
 *   POST /auth/login
 *   POST /auth/logout
 *   GET  /auth/me
 *   POST /auth/change-password
 */

import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from '../../auth/passwords.js';
import {
  signToken,
  revokeSession,
  revokeAllSessionsForAdmin,
} from '../../auth/jwt.js';
import { COOKIE_NAME, cookieOptions } from '../../auth/index.js';
import { sanitizeAuditDetails } from '../../util/sanitize.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;

// dummy hash برای timing-attack resistance (hash of "timing-safe-dummy-value")
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.6mQvT0QGFKf1iJYYgZcPsKcR7vP8xQa';

export default async function authRoutes(fastify: FastifyInstance) {
  // ─────────────── POST /login ───────────────
  fastify.post<{
    Body: { username: string; password: string };
  }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 50 },
            password: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const username = req.body.username.trim().toLowerCase();
      const { password } = req.body;
      const ip = req.ip;
      const userAgent = req.headers['user-agent'] ?? null;

      const logAudit = (
        adminId: number | null,
        success: boolean,
        details: Record<string, unknown> = {}
      ) =>
        pool.query(
          `INSERT INTO admin_audit_log
             (admin_id, username, action, success, details, ip_address, user_agent)
           VALUES ($1, $2, 'login', $3, $4, $5, $6)`,
          [adminId, username, success, sanitizeAuditDetails(details), ip, userAgent]
        );

      const res = await pool.query(
        `SELECT id, password_hash, role, must_change_password, is_active,
                failed_login_count, locked_until
         FROM admins WHERE username = $1`,
        [username]
      );
      const admin = res.rows[0];

      // bcrypt همیشه اجرا می‌شه (timing attack resistance)
      const passwordValid = await verifyPassword(
        password,
        admin?.password_hash ?? DUMMY_HASH
      );

      if (!admin || !admin.is_active) {
        await logAudit(admin?.id ?? null, false, {
          reason: admin ? 'inactive' : 'not_found',
        });
        return reply.code(401).send({ error: 'نام کاربری یا رمز اشتباهه' });
      }

      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        await logAudit(admin.id, false, { reason: 'locked' });
        return reply.code(423).send({
          error: 'حساب به دلیل تلاش‌های ناموفق قفل شده',
          lockedUntil: admin.locked_until,
        });
      }

      if (!passwordValid) {
        const newCount = admin.failed_login_count + 1;
        const shouldLock = newCount >= MAX_FAILED_ATTEMPTS;

        await pool.query(
          `UPDATE admins
           SET failed_login_count = $1,
               locked_until = CASE WHEN $2 THEN NOW() + $3 * INTERVAL '1 minute'
                                   ELSE locked_until END
           WHERE id = $4`,
          [newCount, shouldLock, LOCK_DURATION_MINUTES, admin.id]
        );
        await logAudit(admin.id, false, {
          reason: 'wrong_password',
          attempt: newCount,
          locked: shouldLock,
        });
        return reply.code(401).send({ error: 'نام کاربری یا رمز اشتباهه' });
      }

      // Success
      await pool.query(
        `UPDATE admins
         SET failed_login_count = 0, locked_until = NULL,
             last_login_at = NOW(), last_login_ip = $1
         WHERE id = $2`,
        [ip, admin.id]
      );

      const { token, expiresAt } = await signToken(
        Number(admin.id),
        admin.role,
        admin.must_change_password,
        { ip, userAgent }
      );

      void reply.setCookie(COOKIE_NAME, token, {
        ...cookieOptions,
        expires: expiresAt,
      });

      await logAudit(admin.id, true);

      return {
        success: true,
        admin: {
          id: Number(admin.id),
          username,
          role: admin.role,
          mustChangePassword: admin.must_change_password,
        },
      };
    }
  );

  // ─────────────── POST /logout ───────────────
  fastify.post(
    '/logout',
    { preHandler: fastify.requireAuth },
    async (req, reply) => {
      if (req.admin) {
        await revokeSession(req.admin.jti);
        await pool.query(
          `INSERT INTO admin_audit_log (admin_id, action, success, ip_address, user_agent)
           VALUES ($1, 'logout', true, $2, $3)`,
          [req.admin.sub, req.ip, req.headers['user-agent'] ?? null]
        );
      }
      void reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { success: true };
    }
  );

  // ─────────────── GET /me ───────────────
  fastify.get('/me', { preHandler: fastify.requireAuth }, async (req, reply) => {
    const res = await pool.query(
      `SELECT id, username, role, must_change_password, last_login_at, last_login_ip
       FROM admins WHERE id = $1`,
      [req.admin!.sub]
    );
    if (res.rows.length === 0) return reply.code(404).send({ error: 'not found' });
    const row = res.rows[0];
    return {
      admin: {
        id: Number(row.id),
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password,
        lastLoginAt: row.last_login_at,
        lastLoginIp: row.last_login_ip,
      },
    };
  });

  // ─────────────── POST /change-password ───────────────
  // این route حتی برای mustChangePassword هم باز می‌مونه
  fastify.post<{
    Body: { currentPassword?: string; oldPassword?: string; newPassword: string };
  }>(
    '/change-password',
    {
      preHandler: fastify.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1 },
            oldPassword: { type: 'string', minLength: 1 },
            newPassword: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (req, reply) => {
      const currentPassword = req.body.currentPassword ?? req.body.oldPassword;
      const { newPassword } = req.body;
      if (!currentPassword) {
        return reply.code(400).send({ error: 'رمز فعلی لازمه' });
      }

      const adminId = req.admin!.sub;
      const ip = req.ip;

      if (currentPassword === newPassword) {
        return reply.code(400).send({ error: 'رمز جدید باید با قبلی فرق کنه' });
      }

      const check = validatePasswordStrength(newPassword);
      if (!check.ok) return reply.code(400).send({ error: check.reason });

      const res = await pool.query(
        `SELECT password_hash FROM admins WHERE id = $1 AND is_active = true`,
        [adminId]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'admin not found' });
      }

      const valid = await verifyPassword(currentPassword, res.rows[0].password_hash);
      if (!valid) {
        await pool.query(
          `INSERT INTO admin_audit_log (admin_id, action, success, details, ip_address)
           VALUES ($1, 'password_change', false, $2, $3)`,
          [adminId, sanitizeAuditDetails({ reason: 'wrong_current' }), ip]
        );
        return reply.code(401).send({ error: 'رمز فعلی اشتباهه' });
      }

      const newHash = await hashPassword(newPassword);
      await pool.query(
        `UPDATE admins
         SET password_hash = $1, must_change_password = false, password_changed_at = NOW()
         WHERE id = $2`,
        [newHash, adminId]
      );

      // Security: همه سشن‌ها رو revoke کن
      await revokeAllSessionsForAdmin(adminId);

      await pool.query(
        `INSERT INTO admin_audit_log (admin_id, action, success, ip_address)
         VALUES ($1, 'password_change', true, $2)`,
        [adminId, ip]
      );

      void reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { success: true, message: 'رمز عوض شد. لطفاً دوباره لاگین کن.' };
    }
  );
}
