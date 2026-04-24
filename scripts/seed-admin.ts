/**
 * Seed default admin.
 *
 * اجرا:  npx tsx scripts/seed-admin.ts
 *
 * رمز default `1590320` صرفاً برای اولین لاگینه. flag `must_change_password`
 * باعث می‌شه کار دیگه‌ای نتونی انجام بدی تا رمز رو عوض نکردی.
 */

import 'dotenv/config';
import { pool, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/auth/index.js';

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '1590320';

async function main() {
  // اگه admin از قبل بود، چیزی نکن
  const existing = await pool.query(
    `SELECT id, must_change_password FROM admins WHERE username = $1`,
    [DEFAULT_USERNAME]
  );

  if (existing.rows.length > 0) {
    const a = existing.rows[0];
    console.log(`⚠  admin "${DEFAULT_USERNAME}" از قبل وجود داره (id=${a.id})`);
    if (a.must_change_password) {
      console.log('   هنوز رمز پیش‌فرض فعاله! زودتر عوضش کن.');
    }
    return;
  }

  const hash = await hashPassword(DEFAULT_PASSWORD);
  const res = await pool.query<{ id: number }>(
    `INSERT INTO admins (username, password_hash, role, must_change_password)
     VALUES ($1, $2, 'super_admin', true)
     RETURNING id`,
    [DEFAULT_USERNAME, hash]
  );

  console.log('═══════════════════════════════════════════════════════');
  console.log(`✔  admin ساخته شد (id=${res.rows[0].id})`);
  console.log(`   username: ${DEFAULT_USERNAME}`);
  console.log(`   password: ${DEFAULT_PASSWORD}`);
  console.log('');
  console.log('⚠⚠⚠  این رمز فقط برای اولین لاگینه.');
  console.log('     سیستم اجبارت می‌کنه توی اولین ورود عوضش کنی.');
  console.log('     تا عوض نکنی، هیچ صفحه دیگه‌ای باز نمی‌شه.');
  console.log('═══════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
