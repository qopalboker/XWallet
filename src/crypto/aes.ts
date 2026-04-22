/**
 * AES-256-GCM encryption با key rotation versioned + lazy migration.
 *
 * env vars:
 *   WALLET_MASTER_KEY_V1  (base64, 32 bytes)
 *   WALLET_MASTER_KEY_V2  ...
 *   WALLET_MASTER_KEY     (legacy، اگه باشه به‌عنوان V1 لود می‌شه)
 *
 * encrypt همیشه با بالاترین version موجود انجام می‌شه.
 * decrypt با version‌ای که تو ردیف ذخیره شده.
 *
 * Lazy migration:
 *   service لایه (wallet-service / credentials-service) بعد از موفقیت
 *   decrypt اگه دید enc.version < currentVersion، re-encrypt می‌کنه و
 *   ردیف رو update می‌کنه. این عملیات eventual هست — بدون نیاز به
 *   maintenance window.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

const VERSIONED_ENV_PREFIX = 'WALLET_MASTER_KEY_V';
const LEGACY_ENV = 'WALLET_MASTER_KEY';

interface KeyRing {
  current: number;            // بالاترین version (برای encrypt جدید)
  keys: Map<number, Buffer>;  // version → key buffer
}

let _ring: KeyRing | null = null;

function decodeKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${label} باید دقیقاً ${KEY_LENGTH} بایت باشه (شما ${key.length}).`);
  }
  return key;
}

function loadKeyRing(): KeyRing {
  const keys = new Map<number, Buffer>();

  // versioned: WALLET_MASTER_KEY_V1, V2, ...
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (!name.startsWith(VERSIONED_ENV_PREFIX)) continue;
    const versionStr = name.slice(VERSIONED_ENV_PREFIX.length);
    const version = Number(versionStr);
    if (!Number.isInteger(version) || version < 1) continue;
    keys.set(version, decodeKey(value, name));
  }

  // legacy: WALLET_MASTER_KEY (به‌عنوان v1 اگه v1 از قبل ست نشده)
  const legacy = process.env[LEGACY_ENV];
  if (legacy) {
    if (!keys.has(1)) {
      keys.set(1, decodeKey(legacy, LEGACY_ENV));
    } else if (!keys.get(1)!.equals(decodeKey(legacy, LEGACY_ENV))) {
      throw new Error(
        `هم ${LEGACY_ENV} و هم ${VERSIONED_ENV_PREFIX}1 ست شدن ولی مقدار متفاوت. ` +
        `یکی رو حذف کن.`
      );
    }
  }

  if (keys.size === 0) {
    throw new Error(
      `هیچ master key‌ای پیدا نشد. ` +
      `${LEGACY_ENV} یا ${VERSIONED_ENV_PREFIX}1 رو ست کن:\n` +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const current = Math.max(...keys.keys());
  return { current, keys };
}

function getRing(): KeyRing {
  if (!_ring) _ring = loadKeyRing();
  return _ring;
}

/** برای تست — keyring رو reset می‌کنه */
export function _resetKeyRing(): void {
  _ring = null;
}

export function currentEncryptionVersion(): number {
  return getRing().current;
}

export interface EncryptedMnemonic {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  version: number;
}

export function encryptMnemonic(mnemonic: string): EncryptedMnemonic {
  const ring = getRing();
  const key = ring.keys.get(ring.current)!;
  const nonce = randomBytes(NONCE_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return { ciphertext, nonce, tag, version: ring.current };
}

export function decryptMnemonic(enc: EncryptedMnemonic): string {
  const ring = getRing();
  const key = ring.keys.get(enc.version);
  if (!key) {
    throw new Error(
      `encryption version ${enc.version} پیدا نشد — کلید ${VERSIONED_ENV_PREFIX}${enc.version} رو ست کن`
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, enc.nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(enc.tag);

  const plaintext = Buffer.concat([
    decipher.update(enc.ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

/**
 * اگه ردیف با version قدیمی encrypt شده، یه نسخه جدید (با version فعلی)
 * برمی‌گردونه. اگه از قبل با current هست، null برمی‌گردونه.
 */
export function maybeReEncrypt(enc: EncryptedMnemonic, plaintext: string): EncryptedMnemonic | null {
  const ring = getRing();
  if (enc.version === ring.current) return null;
  return encryptMnemonic(plaintext);
}

// ─── self-test ───
export function selfTest(): void {
  const sample = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const enc = encryptMnemonic(sample);
  const dec = decryptMnemonic(enc);
  if (dec !== sample) {
    throw new Error('crypto self-test failed');
  }

  const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  let tamperingDetected = false;
  try {
    decryptMnemonic(tampered);
  } catch {
    tamperingDetected = true;
  }
  if (!tamperingDetected) {
    throw new Error('tampering detected نشد!');
  }
}
