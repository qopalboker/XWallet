/**
 * یه بار اجرا کن تا credential‌ها رو از env به DB منتقل کنه.
 *
 * استفاده:
 *   1. تو .env بذار:
 *        INITIAL_TRONGRID_KEYS=key1,key2,key3
 *        INITIAL_ETH_RPCS=https://...,https://...
 *   2. npx tsx scripts/seed-credentials.ts
 *   3. بعد خطوط INITIAL_* رو از .env پاک کن (دیگه نیاز نیست)
 *
 * این اسکریپت idempotent نیست! هر بار اجرا کنی دوباره اضافه می‌کنه.
 * فقط یه بار اجرا کن.
 */

import 'dotenv/config';
import { pool, closePool } from '../src/db/pool.js';
import { addCredential, type Provider } from '../src/services/credentials-service.js';

async function seedForProvider(envVar: string, provider: Provider) {
  const raw = process.env[envVar];
  if (!raw) {
    console.log(`  ${envVar} خالیه، skip می‌شه`);
    return 0;
  }

  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) return 0;

  // یه admin id برای created_by
  const adminRes = await pool.query<{ id: number }>(
    `SELECT id FROM admins ORDER BY id ASC LIMIT 1`
  );
  if (adminRes.rows.length === 0) {
    throw new Error('هیچ admin‌ای نیست. اول npm run seed:admin رو اجرا کن');
  }
  const adminId = adminRes.rows[0].id;

  let added = 0;
  for (let i = 0; i < values.length; i++) {
    await addCredential({
      provider,
      value: values[i],
      label: `Initial ${provider} #${i + 1}`,
      adminId,
    });
    added++;
  }
  console.log(`  ✔ ${added} تا ${provider} اضافه شد`);
  return added;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('Seeding API credentials from env...\n');

  const total =
    (await seedForProvider('INITIAL_TRONGRID_KEYS', 'trongrid')) +
    (await seedForProvider('INITIAL_ETH_RPCS', 'eth_rpc')) +
    (await seedForProvider('INITIAL_BTC_APIS', 'btc_api'));

  console.log('');
  console.log(`✔ مجموع ${total} credential اضافه شد`);
  console.log('');
  console.log('⚠ حالا INITIAL_* رو از .env پاک کن (دیگه نیاز نیست)');
  console.log('═══════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
