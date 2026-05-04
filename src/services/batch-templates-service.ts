/**
 * Batch templates service:
 *   - CRUD برای جدول batch_templates
 *   - validateSpec: enforce سقف ۱۰هزار و سایر بازه‌ها سمت سرور (UI bypass)
 *   - runTemplate: یه template رو اجرا کنه — generation_jobs row می‌سازه و
 *     chunk به chunk به wallet-generation queue می‌فرسته. idempotent: اگه
 *     قبلاً یه job در حال اجرا یا pending برای این template ساخته شده،
 *     همون رو برمی‌گردونه.
 *   - isAutoBatchEnabled: env wins، بعد system_settings DB، پیش‌فرض true.
 *
 * Audit: همه‌ی mutation‌ها (create/update/delete/run) تو admin_audit_log ثبت
 * می‌شن. trigger خودکار 'cron' یا 'on_startup' هم با adminId=null لاگ می‌شه.
 */

import { pool } from '../db/pool.js';
import { generationQueue, templateRunsQueue } from '../queue/queues.js';

/**
 * شناسهٔ repeatable job که برای trigger='cron' روی templateRunsQueue ست می‌شه.
 * شکل ثابت: 'tpl-cron:{templateId}' — باعث می‌شه delete/update بتونه دقیقاً
 * همون scheduler رو پیدا و پاک کنه (orphaned cron نمی‌مونه).
 */
function cronSchedulerId(templateId: number): string {
  return `tpl-cron:${templateId}`;
}

async function removeCronScheduler(templateId: number): Promise<void> {
  const id = cronSchedulerId(templateId);
  // BullMQ v5: removeJobScheduler به‌صورت idempotent اگه نباشه فقط false برمی‌گردونه.
  try {
    await templateRunsQueue.removeJobScheduler(id);
  } catch (e) {
    // best-effort — اگه فِیل کرد فقط log کن. cron-run worker خودش 'not_found'
    // رو دفع می‌کنه پس فاجعه نیست.
    console.warn(`[batch-templates] removeJobScheduler(${id}) failed:`, (e as Error).message);
  }
}

async function addCronScheduler(templateId: number, cronExpr: string): Promise<void> {
  // upsertJobScheduler از API جدید BullMQ v5 ست — اگه قبلاً exist داشت
  // override می‌کنه. این متد به removeJobScheduler هم متصله (هردو روی همون
  // registry "jobScheduler" کار می‌کنن، نه repeatable قدیمی).
  await templateRunsQueue.upsertJobScheduler(
    cronSchedulerId(templateId),
    { pattern: cronExpr },
    {
      name: 'tpl-cron',
      data: { templateId, trigger: 'cron' as const },
    }
  );
}

// ─── سقف‌ها (server-side، حتی اگه UI bypass بشه) ───
export const MAX_WALLETS_PER_TEMPLATE = 10_000;
export const MIN_CHUNK_SIZE = 1;
export const MAX_CHUNK_SIZE = 5_000;
export const DEFAULT_CHUNK_SIZE = 250;
export const DEFAULT_COOLDOWN_HOURS = 24;

export type TriggerType = 'on_startup' | 'cron' | 'manual';

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
  enabled: boolean;
  spec: TemplateSpec;
  triggerType: TriggerType;
  cronExpr: string | null;
  cooldownHours: number | null;
  lastRunAt: Date | null;
  lastJobId: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateRow {
  id: string;
  name: string;
  enabled: boolean;
  spec_json: TemplateSpec;
  trigger_type: TriggerType;
  cron_expr: string | null;
  cooldown_hours: number | null;
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
    enabled: r.enabled,
    spec: r.spec_json,
    triggerType: r.trigger_type,
    cronExpr: r.cron_expr,
    cooldownHours: r.cooldown_hours,
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
 * باشه، startup-fire و cron-fire همه از همین رد می‌شن، پس سقف ۱۰هزار حتماً
 * این‌جا اعمال می‌شه.
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

function validateTrigger(triggerType: unknown, cronExpr: unknown): {
  triggerType: TriggerType;
  cronExpr: string | null;
} {
  if (triggerType !== 'on_startup' && triggerType !== 'cron' && triggerType !== 'manual') {
    throw new TemplateValidationError(
      "trigger_type باید یکی از 'on_startup' | 'cron' | 'manual' باشه"
    );
  }

  if (triggerType === 'cron') {
    if (typeof cronExpr !== 'string' || cronExpr.trim().length === 0) {
      throw new TemplateValidationError("برای trigger_type='cron' باید cron_expr بدی");
    }
    // اعتبارسنجی شکل ساده — BullMQ خودش با cron-parser پارس می‌کنه و اگه
    // غلط باشه exception می‌ده. این فقط یه pre-flight ساده‌ست.
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      throw new TemplateValidationError(
        'cron_expr باید ۵ یا ۶ فیلد باشه (مثل "0 2 * * 0")'
      );
    }
    return { triggerType, cronExpr: cronExpr.trim() };
  }

  return { triggerType, cronExpr: null };
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
  enabled?: boolean;
  spec: unknown;
  triggerType: unknown;
  cronExpr?: unknown;
  cooldownHours?: number | null;
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

export async function listEnabledByTrigger(
  triggerType: TriggerType
): Promise<BatchTemplate[]> {
  const r = await pool.query<TemplateRow>(
    `SELECT * FROM batch_templates
       WHERE enabled = true AND trigger_type = $1
       ORDER BY id ASC`,
    [triggerType]
  );
  return r.rows.map(rowToTemplate);
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
  const trig = validateTrigger(input.triggerType, input.cronExpr);
  const cooldown =
    input.cooldownHours == null ? null : Number(input.cooldownHours);
  if (cooldown != null && (!Number.isInteger(cooldown) || cooldown < 0)) {
    throw new TemplateValidationError('cooldown_hours باید عدد صحیح ≥ 0 باشه');
  }

  const r = await pool.query<TemplateRow>(
    `INSERT INTO batch_templates
       (name, enabled, spec_json, trigger_type, cron_expr, cooldown_hours, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.name.trim(),
      input.enabled !== false,
      JSON.stringify(spec),
      trig.triggerType,
      trig.cronExpr,
      cooldown,
      ctx.adminId,
    ]
  );

  const t = rowToTemplate(r.rows[0]);

  // اگه cron + enabled و expr داره، scheduler رو همین الان register کن
  // تا منتظر restart نشیم.
  if (t.triggerType === 'cron' && t.enabled && t.cronExpr) {
    try {
      await addCronScheduler(t.id, t.cronExpr);
    } catch (e) {
      console.warn(
        `[batch-templates] addCronScheduler for new template ${t.id} failed: ${(e as Error).message}`
      );
    }
  }

  await audit(ctx, 'batch_template_create', t.id, true, {
    name: t.name,
    triggerType: t.triggerType,
    spec,
  });
  return t;
}

export interface UpdateTemplateInput {
  name?: string;
  enabled?: boolean;
  spec?: unknown;
  triggerType?: unknown;
  cronExpr?: unknown;
  cooldownHours?: number | null;
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
  if (input.enabled !== undefined) {
    sets.push(`enabled = $${p++}`);
    params.push(Boolean(input.enabled));
  }
  if (input.spec !== undefined) {
    const spec = validateSpec(input.spec);
    sets.push(`spec_json = $${p++}`);
    params.push(JSON.stringify(spec));
  }
  if (input.triggerType !== undefined || input.cronExpr !== undefined) {
    const tt = input.triggerType ?? existing.triggerType;
    const ce = input.cronExpr === undefined ? existing.cronExpr : input.cronExpr;
    const trig = validateTrigger(tt, ce);
    sets.push(`trigger_type = $${p++}`);
    params.push(trig.triggerType);
    sets.push(`cron_expr = $${p++}`);
    params.push(trig.cronExpr);
  }
  if (input.cooldownHours !== undefined) {
    if (input.cooldownHours == null) {
      sets.push(`cooldown_hours = NULL`);
    } else {
      const n = Number(input.cooldownHours);
      if (!Number.isInteger(n) || n < 0) {
        throw new TemplateValidationError('cooldown_hours باید عدد صحیح ≥ 0 باشه');
      }
      sets.push(`cooldown_hours = $${p++}`);
      params.push(n);
    }
  }

  if (sets.length === 0) return existing;

  params.push(id);
  const r = await pool.query<TemplateRow>(
    `UPDATE batch_templates SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
    params
  );

  const t = rowToTemplate(r.rows[0]);

  // sync کردن BullMQ scheduler با وضعیت جدید template:
  //   - قبلاً cron بود ولی trigger عوض شد یا cronExpr عوض شد یا disabled شد
  //     → scheduler قبلی پاک می‌شه
  //   - الان cron + enabled و expr داره (و قبلاً نبود یا تغییر کرد) → re-register
  // delete-then-add ساده‌ترین راهه که هم expr-change و هم enable/disable رو پوشش می‌ده.
  const wasCron = existing.triggerType === 'cron';
  const isCron = t.triggerType === 'cron' && t.enabled && t.cronExpr;
  if (wasCron) {
    await removeCronScheduler(t.id);
  }
  if (isCron) {
    try {
      await addCronScheduler(t.id, t.cronExpr!);
    } catch (e) {
      console.warn(
        `[batch-templates] re-add scheduler for template ${t.id} failed: ${(e as Error).message}`
      );
    }
  }

  await audit(ctx, 'batch_template_update', t.id, true, {
    changedFields: Object.keys(input),
  });
  return t;
}

export async function deleteTemplate(id: number, ctx: AuditCtx): Promise<boolean> {
  // قبل از delete رکورد، اگه trigger=cron بود scheduler رو هم پاک کن تا
  // BullMQ بعدش fire نکنه (و worker با 'not_found' روبرو نشه).
  const existing = await getTemplate(id);
  if (existing && existing.triggerType === 'cron') {
    await removeCronScheduler(id);
  }
  const r = await pool.query(`DELETE FROM batch_templates WHERE id = $1`, [id]);
  const ok = (r.rowCount ?? 0) > 0;
  await audit(ctx, 'batch_template_delete', id, ok, {});
  return ok;
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
 *   2) idempotency: اگه آخرین job مال این template هنوز pending/running ست،
 *      همون رو برمی‌گردونه (reused=true)
 *   3) startUserId رو حل می‌کنه (template ست کرده یا MAX(user_id)+1)
 *   4) overlap check روی wallets
 *   5) generation_jobs row می‌سازه
 *   6) batch رو به chunkهای chunkSize تقسیم می‌کنه و enqueue می‌کنه
 *   7) batch_templates.last_run_at و last_job_id رو به‌روز می‌کنه
 *   8) audit log
 *
 * @param triggerCtx 'manual' | 'cron' | 'on_startup' برای audit
 */
export async function runTemplate(
  templateId: number,
  triggerCtx: 'manual' | 'cron' | 'on_startup',
  ctx: AuditCtx
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
  if (!t.enabled) {
    await audit(ctx, 'batch_template_run', templateId, false, {
      reason: 'disabled',
      trigger: triggerCtx,
    });
    throw new RunBlockedError('disabled', 'template غیرفعال است');
  }

  // 2) idempotency: لای آخرین job این template
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
        const ct = detail.rows[0]?.chunks_total ?? 1;
        const sui = detail.rows[0]?.start_user_id ? Number(detail.rows[0].start_user_id) : 0;
        return {
          jobDbId: t.lastJobId,
          chunksTotal: ct,
          chunkSize: t.spec.chunkSize ?? DEFAULT_CHUNK_SIZE,
          startUserId: sui,
          reused: true,
        };
      }
    }
  }

  // 3) resolve startUserId
  const spec = t.spec;
  let start = spec.startUserId;
  if (!start) {
    const r = await pool.query<{ next: string }>(
      `SELECT COALESCE(MAX(user_id), 0) + 1 AS next FROM wallets`
    );
    start = Number(r.rows[0].next);
  }

  // 4) overlap check
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

  // 5) chunk sizing
  const chunkSize = Math.max(1, Math.min(spec.chunkSize ?? DEFAULT_CHUNK_SIZE, spec.count));
  const chunksTotal = Math.ceil(spec.count / chunkSize);

  // 6) generation_jobs row
  const jobRow = await pool.query<{ id: string }>(
    `INSERT INTO generation_jobs
       (requested_by, word_count, total_count, status,
        chunks_total, chunks_done, failed_count,
        addresses_per_wallet, start_user_id)
     VALUES ($1, $2, $3, 'pending', $4, 0, 0, $5, $6)
     RETURNING id`,
    [ctx.adminId, spec.wordCount, spec.count, chunksTotal, spec.addressesPerWallet, start]
  );
  const jobDbId = Number(jobRow.rows[0].id);

  // 7) enqueue chunks
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

  // 8) update template last_run_at + last_job_id
  await pool.query(
    `UPDATE batch_templates
        SET last_run_at = NOW(), last_job_id = $1
      WHERE id = $2`,
    [jobDbId, templateId]
  );

  await audit(ctx, 'batch_template_run', templateId, true, {
    trigger: triggerCtx,
    jobDbId,
    startUserId: start,
    chunksTotal,
    chunkSize,
    count: spec.count,
  });

  return { jobDbId, chunksTotal, chunkSize, startUserId: start, reused: false };
}

// ─── on_startup gate ────────────────────────────────────────────────────

/**
 * بررسی می‌کنه که آیا یه on_startup template الان باید fire بشه یا نه.
 * منطق: اگه last_run_at نداریم → fire. اگه گذشته‌ی اخیر < cooldown_hours
 * (با پیش‌فرض ۲۴h) → skip.
 */
export function shouldFireOnStartup(t: BatchTemplate, now: Date = new Date()): {
  fire: boolean;
  reason: string;
} {
  if (!t.enabled) return { fire: false, reason: 'disabled' };
  if (t.triggerType !== 'on_startup') return { fire: false, reason: 'wrong_trigger' };

  const cooldown = t.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  if (cooldown === 0) return { fire: true, reason: 'no_cooldown' };
  if (!t.lastRunAt) return { fire: true, reason: 'first_run' };

  const ageMs = now.getTime() - new Date(t.lastRunAt).getTime();
  const cooldownMs = cooldown * 3600 * 1000;
  if (ageMs >= cooldownMs) {
    return { fire: true, reason: 'cooldown_elapsed' };
  }
  return {
    fire: false,
    reason: `cooldown (${Math.round((cooldownMs - ageMs) / 60000)}min remaining)`,
  };
}
