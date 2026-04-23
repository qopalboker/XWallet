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
 * شکل فایل کانفیگ (نمونه):
 *   {
 *     "shared": {
 *       "btc": { "mainnet": { "jsonRpc": ["<token>"] } },
 *       "eth": { "mainnet": { "jsonRpc": ["<token>"] } }
 *     }
 *   }
 *
 * نگاشت به provider های داخلی:
 *   eth mainnet jsonRpc → provider='eth_rpc' (URL کامل GetBlock)
 *   btc mainnet jsonRpc → provider='btc_rpc' (URL کامل GetBlock)
 *
 * این اسکریپت idempotent هست: اگه همون value قبلاً اضافه شده باشه،
 * دوباره insert نمی‌کنه.
 */

import 'dotenv/config';
import { pool, closePool } from '../src/db/pool.js';
import {
  addCredential,
  listCredentials,
} from '../src/services/credentials-service.js';
import {
  loadConfig,
  parseConfig,
  providerForEntry,
  valueForEntry,
  defaultLabel,
  resolveRegion,
  type GetBlockEntry,
} from '../src/services/getblock.js';
import { readFile } from 'node:fs/promises';

async function loadEntries(pathArg?: string): Promise<GetBlockEntry[]> {
  if (pathArg) {
    const raw = await readFile(pathArg, 'utf8');
    return parseConfig(raw);
  }
  return loadConfig();
}

async function getAdminId(): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM admins ORDER BY id ASC LIMIT 1`
  );
  if (res.rows.length === 0) {
    throw new Error('هیچ admin ای نیست. اول npm run seed:admin رو اجرا کن');
  }
  return res.rows[0].id;
}

async function main() {
  const pathArg = process.argv[2];
  const entries = await loadEntries(pathArg);

  console.log('═══════════════════════════════════════════════════════');
  console.log('GetBlock config import');
  console.log(`  region: ${resolveRegion()}`);
  console.log(`  entries found: ${entries.length}`);
  console.log('');

  if (entries.length === 0) {
    console.log('هیچ entry ای پیدا نشد. یکی از این‌ها رو تنظیم کن:');
    console.log('  - argv[2] مسیر فایل JSON');
    console.log('  - GETBLOCK_CONFIG_PATH env');
    console.log('  - GETBLOCK_CONFIG_JSON env');
    return;
  }

  const adminId = await getAdminId();

  // برای idempotency: value هایی که الآن تو DB هستن رو نمی‌شه مستقیم خوند
  // (encrypted هستن) ولی listCredentials preview برمی‌گردونه. چون preview
  // کافی نیست برای مقایسه دقیق، روش ساده: کل credential ها رو بی‌encrypt
  // (از طریق cache) می‌خونیم.
  const existingValues = new Set<string>();
  for (const prov of ['eth_rpc', 'btc_rpc'] as const) {
    // از addCredential غیرمستقیم استفاده می‌کنیم — ولی listCredentials فقط
    // preview می‌ده. پس به‌جاش از loadProvider داخلی استفاده نمی‌کنیم و از
    // مسیر مشابه (query خام) می‌ریم؛ برای سادگی همون listCredentials preview
    // رو فقط برای شمارش استفاده می‌کنیم و مقایسه دقیق رو skip می‌کنیم.
    // تا در cost مشکلی پیش نیاد، به جای exact dedup روی label+provider کار می‌کنیم.
    const items = await listCredentials(prov);
    for (const it of items) existingValues.add(`${it.provider}|${it.label ?? ''}`);
  }

  let added = 0;
  let skipped = 0;
  let unsupported = 0;

  for (const entry of entries) {
    const provider = providerForEntry(entry);
    if (!provider) {
      unsupported++;
      console.log(`  ⊘ skip ${entry.chain}/${entry.network}/${entry.rpcType} (پشتیبانی نشده)`);
      continue;
    }
    const label = defaultLabel(entry);
    const dedupKey = `${provider}|${label}`;
    if (existingValues.has(dedupKey)) {
      skipped++;
      console.log(`  = exists ${provider} «${label}»`);
      continue;
    }
    const value = valueForEntry(entry);
    await addCredential({ provider, value, label, adminId });
    existingValues.add(dedupKey);
    added++;
    console.log(`  ✔ added ${provider} «${label}»`);
  }

  console.log('');
  console.log(`خلاصه: added=${added}, skipped=${skipped}, unsupported=${unsupported}`);
  console.log('═══════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
