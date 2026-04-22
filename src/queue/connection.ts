/**
 * BullMQ connection factory.
 * BullMQ نیاز به maxRetriesPerRequest=null داره که با استفاده عمومی Redis تداخل داره،
 * پس connection جداگونه می‌سازیم.
 */

import { Redis, type RedisOptions } from 'ioredis';

export function createQueueConnection(): Redis {
  const options: RedisOptions = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    maxRetriesPerRequest: null,  // اجباری برای BullMQ
    enableReadyCheck: true,
  };

  return new Redis(options);
}

export const QUEUE_NAMES = {
  GENERATION: 'wallet-generation',
  BALANCE_CHECK: 'balance-check',
  CLEANUP: 'cleanup',
} as const;
