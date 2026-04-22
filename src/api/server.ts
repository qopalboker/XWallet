/**
 * Fastify server
 *   - Security headers (helmet + CSP)
 *   - Cookie parsing
 *   - Rate limiting
 *   - Static serving برای پنل
 *   - Route registration با prefix مناسب
 *   - Graceful shutdown
 */

import 'dotenv/config';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallets.js';
import { jobRoutes } from './routes/jobs.js';
import { credentialRoutes } from './routes/credentials.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { statsRoutes } from './routes/stats.js';
import { registerAuthDecorators } from '../auth/index.js';
import { cleanupOnStartup } from '../services/benchmark-service.js';
import { cleanupExpiredSessions } from '../auth/jwt.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';
import { selfTest as cryptoSelfTest } from '../crypto/aes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function validateEnv(): void {
  const required = ['WALLET_MASTER_KEY', 'JWT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
      `بساز با:\n  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  if ((process.env.JWT_SECRET ?? '').length < 32) {
    throw new Error('JWT_SECRET باید حداقل ۳۲ کاراکتر باشه');
  }
  if (!process.env.COOKIE_SECRET || process.env.COOKIE_SECRET.length < 32) {
    // fallback به JWT_SECRET، ولی warning بده
    if (process.env.NODE_ENV === 'production') {
      throw new Error('COOKIE_SECRET باید تنظیم و حداقل ۳۲ کاراکتر باشه (production)');
    }
  }
}

export async function buildServer() {
  validateEnv();

  // self-test encryption تا مطمئن بشیم master key کار می‌کنه
  cryptoSelfTest();

  const isProd = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: isProd ? undefined : { target: 'pino-pretty' },
      // فیلدهای حساس از log حذف بشن. paths از داکومنت pino:
      //   https://getpino.io/#/docs/redaction
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.oldPassword',
          'req.body.newPassword',
          'req.body.value',          // credentials POST body
          'req.body.mnemonic',
          '*.password',
          '*.token',
          '*.mnemonic',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(req: { id: string; method: string; url: string; ip?: string; admin?: { sub?: number; role?: string } }) {
          return {
            reqId: req.id,
            method: req.method,
            url: req.url,
            ip: req.ip,
            adminId: req.admin?.sub,
            role: req.admin?.role,
          };
        },
      },
    },
    // request id: از header X-Request-Id استفاده کن، در غیر این صورت UUID بساز
    genReqId: (req): string => {
      const fromHeader = req.headers['x-request-id'];
      if (typeof fromHeader === 'string' && fromHeader.length > 0 && fromHeader.length <= 64) {
        return fromHeader;
      }
      return randomUUID();
    },
    trustProxy: true,
    bodyLimit: 1 * 1024 * 1024, // 1MB
    disableRequestLogging: false,
  });

  // X-Request-Id رو به response اضافه کن (برای trace توسط کلاینت)
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  // ─── Security headers ───
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.tailwindcss.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });

  // ─── Cookie ───
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET ?? process.env.JWT_SECRET,
  });

  // ─── Rate limiting (global default) ───
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: (req) => req.url?.startsWith('/public/') ?? false,
  });

  // ─── Auth decorators (must be registered before routes that use them) ───
  registerAuthDecorators(app);

  // ─── Routes ───
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(walletRoutes, { prefix: '/api/wallets' });
  await app.register(jobRoutes);
  await app.register(credentialRoutes);
  await app.register(benchmarkRoutes);
  await app.register(statsRoutes);

  // Health check
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // ─── Static panel ───
  await app.register(staticPlugin, {
    root: join(__dirname, '../../public'),
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback — هر route ناشناخته بره به index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/auth')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });

  // Global error handler — جلوی leak جزئیات داخلی رو بگیره
  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err, url: request.url }, 'request error');
    const statusCode = err.statusCode ?? 500;
    const safeMessage = statusCode < 500
      ? err.message
      : 'خطای سمت سرور';
    void reply.code(statusCode).send({ error: safeMessage });
  });

  return app;
}

// ─── Bootstrap ───
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  buildServer()
    .then(async (app) => {
      await app.listen({ port, host });
      app.log.info(`پنل روی ${host}:${port} بالا اومد`);

      // cleanup های یه‌بارمصرف startup
      await cleanupOnStartup();
      await cleanupExpiredSessions().catch((e) => app.log.warn({ e }, 'session cleanup failed'));

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        app.log.info(`[${signal}] shutting down...`);
        try {
          await app.close();
          await closePool();
          await closeRedis();
          process.exit(0);
        } catch (e) {
          app.log.error({ e }, 'shutdown error');
          process.exit(1);
        }
      };

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
