/**
 * GetBlock shared configuration file رو تو api_credentials DB وارد می‌کنه.
 *
 * استفاده:
 *   # یا با مسیر فایل:
 *   npx tsx scripts/import-getblock.ts /path/to/getblock-config.json
 *
 *   # یا با env:
 *   GETBLOCK_CONFIG_PATH=/path/to/getblock-config.json \
 *     npx tsx scripts/import-getblock.ts
 *
 *   # یا inline JSON:
 *   GETBLOCK_CONFIG_JSON='{"shared":{...}}' \
 *     npx tsx scripts/import-getblock.ts
 *
 * نگاشت به provider های داخلی:
 *   eth mainnet jsonRpc → provider='eth_rpc' (URL کامل GetBlock؛ benchmark_allowed=false)
 *   btc mainnet jsonRpc → skip با لاگ واضح (فعلاً مصرف‌کننده نداریم)
 *
 * اسکریپت idempotent هست: بر پایهٔ (provider, label) dedup می‌کنه و logic
 * کامل import همون چیزی هست که admin panel استفاده می‌کنه (src/services/getblock.ts).
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool, closePool } from '../src/db/pool.js';
import { importGetBlockConfig, resolveRegion } from '../src/services/getblock.js';

async function getAdminId(): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM admins ORDER BY id ASC LIMIT 1`
  );
  if (res.rows.length === 0) {
    throw new Error('هیچ admin ای نیست. اول npm run seed:admin رو اجرا کن');
  }
  return res.rows[0].id;
}

async function loadRawConfig(pathArg?: string): Promise<string | null> {
  if (pathArg) return readFile(pathArg, 'utf8');
  const envPath = process.env.GETBLOCK_CONFIG_PATH;
  if (envPath) return readFile(envPath, 'utf8');
  const inline = process.env.GETBLOCK_CONFIG_JSON;
  return inline ?? null;
}

async function main() {
  const pathArg = process.argv[2];
  const raw = await loadRawConfig(pathArg);

  console.log('═══════════════════════════════════════════════════════');
  console.log('GetBlock config import');
  console.log(`  region: ${resolveRegion()}`);

  if (!raw) {
    console.log('');
    console.log('هیچ کانفیگی پیدا نشد. یکی از این‌ها رو تنظیم کن:');
    console.log('  - argv[2] مسیر فایل JSON');
    console.log('  - GETBLOCK_CONFIG_PATH env');
    console.log('  - GETBLOCK_CONFIG_JSON env');
    console.log('═══════════════════════════════════════════════════════');
    return;
  }

  const adminId = await getAdminId();
  const result = await importGetBlockConfig(raw, { adminId, skipExisting: true });

  console.log('');
  console.log(`added:       ${result.added}`);
  console.log(`skipped:     ${result.skipped} (از این ${result.skippedBtc} تا BTC)`);
  console.log(`invalid:     ${result.invalid.length}`);
  for (const msg of result.invalid) console.log(`  ⚠ ${msg}`);
  console.log('═══════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
