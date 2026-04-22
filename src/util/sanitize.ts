/**
 * Audit log sanitizer.
 *
 *   - Recursive blocklist بر اساس key (regex حساس)
 *   - تمام مقادیر key های حساس به '[REDACTED]' تبدیل می‌شن
 *   - cap حجم نهایی: 8KB (بعد از stringify). اگه بزرگ‌تر بود، truncate
 *
 * استفاده: sanitizeAuditDetails(arbitraryObject) قبل از INSERT تو jsonb.
 */

const SENSITIVE_KEY_REGEX = /password|passwd|pwd|secret|token|api[_-]?key|cookie|session|mnemonic|seed|private[_-]?key|priv[_-]?key|auth(orization)?/i;
const MAX_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
const MAX_STRING = 1024;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') {
    return (value as string).length > MAX_STRING
      ? (value as string).slice(0, MAX_STRING) + '…'
      : value;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }

  return '[UNSUPPORTED_TYPE]';
}

/**
 * sanitize + cap.
 *
 * ورودی هر شکلی می‌تونه باشه (object, primitive, ...).
 * خروجی همیشه یه object قابل ذخیره تو jsonb هست.
 */
export function sanitizeAuditDetails(details: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(details, 0);

  // اگه ورودی primitive بود، تو یه field بسته‌بندی کن
  const wrapped: Record<string, unknown> =
    sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : { value: sanitized };

  // cap حجم
  const json = JSON.stringify(wrapped);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    return {
      _truncated: true,
      _originalBytes: Buffer.byteLength(json, 'utf8'),
      preview: json.slice(0, MAX_BYTES - 256),
    };
  }
  return wrapped;
}
