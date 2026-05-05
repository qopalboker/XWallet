/**
 * Batch templates service:
 *   - CRUD برای جدول batch_templates
 *   - validateSpec: enforce سقف ۱۰هزار و سایر بازه‌ها سمت سرور (UI bypass)
 *   - runTemplate: یه template رو اجرا کنه — generation_jobs row می‌سازه و
 *     chunk به chunk به wallet-generation queue می‌فرسته. idempotent: اگه
 *     آخرین job این template هنوز pending/running ست، همون رو برمی‌گردونه.
 *   - setTemplateStatus: تغییر بین 'active' (chain ادامه پیدا کنه) و
 *     'paused' (هیچ spawn جدیدی نشه؛ batch فعلی عادی تموم می‌شه).
 *   - isAutoBatchEnabled: env wins، بعد system_settings DB، پیش‌فرض true.
 *
 * Trigger model:
 *   تو نسخهٔ قبل سه trigger داشتیم (manual / on_startup / cron). الان فقط
 *   chain-on-completion: وقتی یه batch تموم می‌شه، generation worker خودش
 *   نسخه بعدی رو spawn می‌کنه (تو src/queue/workers/generation.ts). bootstrap
 *   اولین batch به صورت دستی از طریق POST /api/batch-templates/:id/start
 *   انجام می‌شه.
 *
 * Audit: همه‌ی mutation‌ها (create/update/delete/run/status-change) تو
 * admin_audit_log ثبت می‌شن. trigger خودکار 'chain' با adminId=null لاگ می‌شه.
 */

import { pool } from '../db/pool.js';
import { generationQueue } from '../queue/queues.js';

// ─── سقف‌ها (server-side، حتی اگه UI bypass بشه) ───
export const MAX_WALLETS_PER_TEMPLATE = 10_000;
export const MIN_CHUNK_SIZE = 1;
export const MAX_CHUNK_SIZE = 5_000;
export const DEFAULT_CHUNK_SIZE = 250;

export type Status = 'active' | 'paused';

export interface TemplateSpec {
  wordCount: 12 | 24;
  addressesPerWallet: number;
  count: number;
  startUserId?: number;
  chunkSize?: number;
}

export interface BatchTemplate {
  id: number;
  name: string;
  status: Status;
  cooldownSeconds: number;
  spec: TemplateSpec;
  lastRunAt: Date | null;
  lastJobId: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateRow {
  id: string;
  name: string;
  status: Status;
  cooldown_seconds: number;
  spec_json: TemplateSpec;
  last_run_at: Date | null;
  last_job_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToTemplate(r: TemplateRow): BatchTemplate {
  return {
    id: Number(r.id),
    name: r.name,
    status: r.status,
    cooldownSeconds: r.cooldown_seconds,
    spec: r.spec_json,
    lastRunAt: r.last_run_at,
    lastJobId: r.last_job_id == null ? null : Number(r.last_job_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── validation ─────────────────────────────────────────────────────────

export class TemplateValidationError extends Error {
  readonly code = 'TEMPLATE_VALIDATION';
  readonly statusCode = 400;
  constructor(reason: string) {
    super(reason);
    this.name = 'TemplateValidationError';
  }
}

/**
 * spec رو اعتبارسنجی می‌کنه. این تابع نباید UI رو منعکس کنه — حتی اگه ولید هم
 * باشه، chain-spawn هم از همین رد می‌شه، پس سقف ۱۰هزار حتماً این‌جا اعمال می‌شه.
 */
export function validateSpec(raw: unknown): TemplateSpec {
  if (!raw || typeof raw !== 'object') {
    throw new TemplateValidationError('spec باید object باشه');
  }
  const s = raw as Record<string, unknown>;

  const wordCount = s.wordCount;
  if (wordCount !== 12 && wordCount !== 24) {
    throw new TemplateValidationError('wordCount باید ۱۲ یا ۲۴ باشه');
  }

  const addr = Number(s.addressesPerWallet);
  if (!Number.isInteger(addr) || addr < 1 || addr > 20) {
    throw new TemplateValidationError('addressesPerWallet باید بین ۱ و ۲۰ باشه');
  }

  const count = Number(s.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WALLETS_PER_TEMPLATE) {
    throw new TemplateValidationError(
      `count باید بین ۱ و ${MAX_WALLETS_PER_TEMPLATE} باشه`
    );
  }

  const out: TemplateSpec = { wordCount, addressesPerWallet: addr, count };

  if (s.startUserId !== undefined && s.startUserId !== null) {
    const su = Number(s.startUserId);
    if (!Number.isInteger(su) || su < 1) {
      throw new TemplateValidationError('startUserId باید عدد صحیح مثبت باشه');
    }
    out.startUserId = su;
  }

  if (s.chunkSize !== undefined && s.chunkSize !== null) {
    const cs = Number(s.chunkSize);
    if (!Number.isInteger(cs) || cs < MIN_CHUNK_SIZE || cs > MAX_CHUNK_SIZE) {
      throw new TemplateValidationError(
        `chunkSize باید بین ${MIN_CHUNK_SIZE} و ${MAX_CHUNK_SIZE} باشه`
      );
    }
    out.chunkSize = cs;
  }

  return out;
}

function isPgUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: string }).code === '23505'
  );
}

function validateCooldownSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new TemplateValidationError('cooldown_seconds باید عدد صحیح ≥ 0 باشه');
  }
  return n;
}

// ─── audit ──────────────────────────────────────────────────────────────

export interface AuditCtx {
  adminId: number | null;
  username: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

async function audit(
  ctx: AuditCtx,
  action: string,
  templateId: number | null,
  success: boolean,
  details: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO admin_audit_log
       (admin_id, username, action, target_type, target_id, success, details, ip_address, user_agent)
     VALUES ($1, $2, $3, 'batch_template', $4, $5, $6, $7, $8)`,
    [
      ctx.adminId,
      ctx.username,
      action,
      templateId,
      success,
      JSON.stringify(details),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
    ]
  );
}

// ─── circuit breaker ────────────────────────────────────────────────────

/**
 * AUTO_BATCH_ENABLED:
 *   اولویت: env > DB > پیش‌فرض true.
 *   env: AUTO_BATCH_ENABLED=false (هر مقدار غیر از 'true' هم false در نظر گرفته می‌شه)
 *   DB:  system_settings(key='auto_batch_enabled', value='true'|'false')
 */
export async function isAutoBatchEnabled(): Promise<{
  enabled: boolean;
  source: 'env' | 'db' | 'default';
}> {
  const envVal = process.env.AUTO_BATCH_ENABLED;
  if (envVal !== undefined && envVal !== '') {
    return { enabled: envVal.toLowerCase() === 'true', source: 'env' };
  }
  try {
    const r = await pool.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = 'auto_batch_enabled'`
    );
    if (r.rows.length > 0) {
      return { enabled: r.rows[0].value.toLowerCase() === 'true', source: 'db' };
    }
  } catch {
    // اگه جدول نباشه (migration هنوز اجرا نشده) — به default fall back
  }
  return { enabled: true, source: 'default' };
}

export async function setAutoBatchEnabled(
  enabled: boolean,
  ctx: AuditCtx
): Promise<void> {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES ('auto_batch_enabled', $1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [enabled ? 'true' : 'false', ctx.adminId]
  );
  await audit(ctx, 'auto_batch_toggle', null, true, { enabled });
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export interface CreateTemplateInput {
  name: string;
  status?: Status;
  cooldownSeconds?: number;
  spec: unknown;
}

export async function listTemplates(): Promise<BatchTemplate[]> {
  const r = await pool.query<TemplateRow>(
    `SELECT * FROM batch_templates ORDER BY id DESC`
  );
  return r.rows.map(rowToTemplate);
}

export async function getTemplate(id: number): Promise<BatchTemplate | null> {
  const r = await pool.query<TemplateRow>(
    `SELECT * FROM batch_templates WHERE id = $1`,
    [id]
  );
  if (r.rows.length === 0) return null;
  return rowToTemplate(r.rows[0]);
}

export async function createTemplate(
  input: CreateTemplateInput,
  ctx: AuditCtx
): Promise<BatchTemplate> {
  if (!input.name || input.name.trim().length === 0) {
    throw new TemplateValidationError('name اجباری‌ست');
  }
  if (input.name.length > 100) {
    throw new TemplateValidationError('name حداکثر ۱۰۰ کاراکتر');
  }

  const spec = validateSpec(input.spec);
  const cooldown = validateCooldownSeconds(input.cooldownSeconds);
  const status: Status =
    input.status === 'active' ? 'active' : 'paused'; // پیش‌فرض paused — اپراتور صراحتاً start می‌زنه

  const r = await pool.query<TemplateRow>(
    `INSERT INTO batch_templates
       (name, status, cooldown_seconds, spec_json, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.name.trim(), status, cooldown, JSON.stringify(spec), ctx.adminId]
  );

  const t = rowToTemplate(r.rows[0]);
  await audit(ctx, 'batch_template_create', t.id, true, {
    name: t.name,
    status: t.status,
    cooldownSeconds: t.cooldownSeconds,
    spec,
  });
  return t;
}

export interface UpdateTemplateInput {
  name?: string;
  spec?: unknown;
  cooldownSeconds?: number;
}

export async function updateTemplate(
  id: number,
  input: UpdateTemplateInput,
  ctx: AuditCtx
): Promise<BatchTemplate | null> {
  const existing = await getTemplate(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new TemplateValidationError('name نمی‌تونه خالی باشه');
    }
    sets.push(`name = $${p++}`);
    params.push(input.name.trim());
  }
  if (input.spec !== undefined) {
    const spec = validateSpec(input.spec);
    sets.push(`spec_json = $${p++}`);
    params.push(JSON.stringify(spec));
  }
  if (input.cooldownSeconds !== undefined) {
    const n = validateCooldownSeconds(input.cooldownSeconds);
    sets.push(`cooldown_seconds = $${p++}`);
    params.push(n);
  }

  if (sets.length === 0) return existing;

  params.push(id);
  const r = await pool.query<TemplateRow>(
    `UPDATE batch_templates SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
    params
  );

  const t = rowToTemplate(r.rows[0]);
  await audit(ctx, 'batch_template_update', t.id, true, {
    changedFields: Object.keys(input),
  });
  return t;
}

export async function deleteTemplate(id: number, ctx: AuditCtx): Promise<boolean> {
  const r = await pool.query(`DELETE FROM batch_templates WHERE id = $1`, [id]);
  const ok = (r.rowCount ?? 0) > 0;
  await audit(ctx, 'batch_template_delete', id, ok, {});
  return ok;
}

/**
 * status رو بین 'active' و 'paused' تغییر می‌ده. اگه قبلاً همون مقدار بوده،
 * بدون تغییر برمی‌گرده ولی audit log می‌ندازه (برای trace operator action).
 *
 * pause از روی یه chain فعال:
 *   - batch فعلی عادی تموم می‌شه (هیچ‌جا cancel نمی‌کنیم)
 *   - chain-spawn هندلر تو generation worker وقتی finalize می‌بینه
 *     status='paused' هست، spawn نمی‌کنه و chain تموم می‌شه
 *
 * resume:
 *   - فقط status رو 'active' می‌کنه. خود این batch جدید fire نمی‌کنه؛
 *     bootstrap اولین run با /start (که دستی runTemplate صدا می‌زنه) انجام می‌شه.
 */
export async function setTemplateStatus(
  id: number,
  status: Status,
  ctx: AuditCtx,
  details: Record<string, unknown> = {},
): Promise<BatchTemplate | null> {
  const existing = await getTemplate(id);
  if (!existing) return null;

  if (existing.status !== status) {
    await pool.query(
      `UPDATE batch_templates SET status = $1 WHERE id = $2`,
      [status, id]
    );
  }

  await audit(ctx, 'batch_template_status', id, true, {
    from: existing.status,
    to: status,
    ...details,
  });

  return { ...existing, status };
}

// ─── runTemplate ────────────────────────────────────────────────────────

export interface RunResult {
  jobDbId: number;
  chunksTotal: number;
  chunkSize: number;
  startUserId: number;
  reused: boolean;            // true اگه already-running job رو برگردوندیم
  skippedReason?: string;     // اگه به دلیلی اجرا نشد (e.g. circuit breaker)
}

export class RunBlockedError extends Error {
  readonly code: string;
  readonly statusCode = 409;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RunBlockedError';
  }
}

/**
 * یه template رو اجرا می‌کنه. مراحل:
 *   1) circuit breaker check (AUTO_BATCH_ENABLED)
 *   2) اگه trigger='chain' و status='paused' → skip (chain متوقفه)
 *      manual به status بی‌اعتنا‌ست — escape hatch برای force-run
 *   3) idempotency: اگه آخرین job مال این template هنوز pending/running ست،
 *      همون رو برمی‌گردونه (reused=true)
 *   4) startUserId رو حل می‌کنه (template ست کرده یا MAX(user_id)+1)
 *   5) overlap check روی wallets
 *   6) generation_jobs row می‌سازه (با template_id و parent_job_id)
 *   7) batch رو به chunkهای chunkSize تقسیم می‌کنه و enqueue می‌کنه
 *   8) batch_templates.last_run_at و last_job_id رو به‌روز می‌کنه
 *   9) audit log
 *
 * @param parentJobId job ای که finalize-ش این run رو spawn کرد. فقط
 *   trigger='chain' این رو set می‌کنه. unique-index روی parent_job_id
 *   تو generation_jobs تضمین می‌کنه که هر parent حداکثر یه child داشته باشه
 *   حتی اگه finalize handler دو بار fire بشه. کالر باید 23505 رو catch کنه.
 */
export async function runTemplate(
  templateId: number,
  triggerCtx: 'manual' | 'chain',
  ctx: AuditCtx,
  parentJobId: number | null = null,
): Promise<RunResult> {
  // 1) circuit breaker
  const cb = await isAutoBatchEnabled();
  if (!cb.enabled) {
    await audit(ctx, 'batch_template_run', templateId, false, {
      reason: 'auto_batch_disabled',
      source: cb.source,
      trigger: triggerCtx,
    });
    throw new RunBlockedError(
      'auto_batch_disabled',
      `auto-batch غیرفعاله (source=${cb.source})`
    );
  }

  const t = await getTemplate(templateId);
  if (!t) {
    throw new RunBlockedError('not_found', `template ${templateId} پیدا نشد`);
  }

  // 2) chain-spawn فقط وقتی status='active' باشه fire می‌شه. manual بی‌اعتناست.
  if (triggerCtx === 'chain' && t.status !== 'active') {
    await audit(ctx, 'batch_template_run', templateId, false, {
      reason: 'paused',
      trigger: triggerCtx,
      parentJobId,
    });
    throw new RunBlockedError('paused', 'chain متوقف شده — spawn رد شد');
  }

  // 3) idempotency: لای آخرین job این template
  if (t.lastJobId != null) {
    const last = await pool.query<{ status: string }>(
      `SELECT status FROM generation_jobs WHERE id = $1`,
      [t.lastJobId]
    );
    if (last.rows.length > 0) {
      const st = last.rows[0].status;
      if (st === 'pending' || st === 'running') {
        await audit(ctx, 'batch_template_run', templateId, true, {
          reused: true,
          trigger: triggerCtx,
          jobDbId: t.lastJobId,
        });
        const detail = await pool.query<{ chunks_total: number; start_user_id: string | null }>(
          `SELECT chunks_total, start_user_id FROM generation_jobs WHERE id = $1`,
          [t.lastJobId]
        );
        const cT = detail.rows[0]?.chunks_total ?? 1;
        const sui = detail.rows[0]?.start_user_id ? Number(detail.rows[0].start_user_id) : 0;
        return {
          jobDbId: t.lastJobId,
          chunksTotal: cT,
          chunkSize: t.spec.chunkSize ?? DEFAULT_CHUNK_SIZE,
          startUserId: sui,
          reused: true,
        };
      }
    }
  }

  // 4) resolve startUserId
  const spec = t.spec;
  let start = spec.startUserId;
  if (!start) {
    const r = await pool.query<{ next: string }>(
      `SELECT COALESCE(MAX(user_id), 0) + 1 AS next FROM wallets`
    );
    start = Number(r.rows[0].next);
  }

  // 5) overlap check
  const overlap = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM wallets
       WHERE user_id >= $1 AND user_id < $2`,
    [start, start + spec.count]
  );
  if (Number(overlap.rows[0].cnt) > 0) {
    await audit(ctx, 'batch_template_run', templateId, false, {
      reason: 'user_id_overlap',
      trigger: triggerCtx,
      startUserId: start,
      count: spec.count,
    });
    throw new RunBlockedError(
      'overlap',
      `user_id از ${start} تا ${start + spec.count - 1} قبلاً استفاده شده`
    );
  }

  // 6) chunk sizing
  const chunkSize = Math.max(1, Math.min(spec.chunkSize ?? DEFAULT_CHUNK_SIZE, spec.count));
  const chunksTotal = Math.ceil(spec.count / chunkSize);

  // 7) generation_jobs row — template_id و parent_job_id رو ست می‌کنیم.
  // اگه parent_job_id duplicate باشه (race بین دو chain-spawn handler)،
  // unique-index روی generation_jobs(parent_job_id) WHERE NOT NULL برای 23505
  // raise می‌ده. اون‌جا تبدیل به RunBlockedError('duplicate_chain_spawn') می‌شه
  // که کالر هندل می‌کنه (ad-hoc inline تو generation worker یا template-chain
  // worker — هردو RunBlockedError رو فقط log می‌کنن و موفق برمی‌گردن).
  let jobDbId: number;
  try {
    const jobRow = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs
         (requested_by, word_count, total_count, status,
          chunks_total, chunks_done, failed_count,
          addresses_per_wallet, start_user_id,
          template_id, parent_job_id)
       VALUES ($1, $2, $3, 'pending', $4, 0, 0, $5, $6, $7, $8)
       RETURNING id`,
      [
        ctx.adminId,
        spec.wordCount,
        spec.count,
        chunksTotal,
        spec.addressesPerWallet,
        start,
        templateId,
        parentJobId,
      ]
    );
    jobDbId = Number(jobRow.rows[0].id);
  } catch (e) {
    if (parentJobId != null && isPgUniqueViolation(e)) {
      await audit(ctx, 'batch_template_run', templateId, false, {
        reason: 'duplicate_chain_spawn',
        trigger: triggerCtx,
        parentJobId,
      });
      throw new RunBlockedError(
        'duplicate_chain_spawn',
        `parent ${parentJobId} already has a chain child — race lost`
      );
    }
    throw e;
  }

  // 8) enqueue chunks
  for (let i = 0; i < chunksTotal; i++) {
    const chunkStart = start + i * chunkSize;
    const chunkCount = Math.min(chunkSize, spec.count - i * chunkSize);
    await generationQueue.add(
      'generate',
      {
        jobDbId,
        startUserId: chunkStart,
        count: chunkCount,
        wordCount: spec.wordCount,
        addressesPerWallet: spec.addressesPerWallet,
        chunkIndex: i,
        chunksTotal,
      },
      { jobId: `gen:${jobDbId}:${i}` }
    );
  }

  // 9) update template last_run_at + last_job_id
  await pool.query(
    `UPDATE batch_templates
        SET last_run_at = NOW(), last_job_id = $1
      WHERE id = $2`,
    [jobDbId, templateId]
  );

  await audit(ctx, 'batch_template_run', templateId, true, {
    trigger: triggerCtx,
    jobDbId,
    parentJobId,
    startUserId: start,
    chunksTotal,
    chunkSize,
    count: spec.count,
  });

  return { jobDbId, chunksTotal, chunkSize, startUserId: start, reused: false };
}
