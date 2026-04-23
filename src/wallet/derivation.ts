/**
 * HD Wallet derivation برای BTC / ETH / TRON
 *
 * Pattern B: هر کاربر یه mnemonic داره، به ازای هر deposit یه index جدید.
 * Path‌ها کاملاً با Trust Wallet و MetaMask سازگارن.
 *
 * Batch-ready: یه تابع deriveMany می‌تونه n آدرس رو یه جا بسازه
 * بدون اینکه n بار از seed رو parse کنه (یه بار master، بقیه derive سریع).
 */

import * as bip39 from 'bip39';
import { BIP32Factory, type BIP32Interface } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { getAddress, keccak256 } from 'ethers';
import bs58check from 'bs58check';
import { randomBytes, randomFillSync } from 'node:crypto';

const bip32 = BIP32Factory(ecc);

// ─── Derivation paths (Trust Wallet standard) ───
//
// BTC: پیش‌فرض Native SegWit هست (m/84') — هم‌راستا با Trust Wallet و
// MetaMask امروزی. ولی برای import از ولت‌های قدیمی‌تر (Trust قدیم، Electrum
// legacy، Bitcoin Core قدیمی، …) باید Legacy و P2SH-wrapped SegWit هم چک
// بشن وگرنه کاربر فکر می‌کنه موجودی قدیمی‌ش گم شده.
export const BTC_PATHS = {
  legacy: (i: number) => `m/44'/0'/0'/0/${i}`,  // P2PKH (1…)
  p2sh:   (i: number) => `m/49'/0'/0'/0/${i}`,  // P2SH-P2WPKH (3…)
  segwit: (i: number) => `m/84'/0'/0'/0/${i}`,  // Native SegWit / P2WPKH (bc1…) — default
} as const;

export type BtcAddressType = keyof typeof BTC_PATHS;
export const BTC_ADDRESS_TYPES = ['segwit', 'p2sh', 'legacy'] as const satisfies readonly BtcAddressType[];

export const PATHS = {
  BTC: BTC_PATHS.segwit,                        // default: Native SegWit
  ETH: (i: number)  => `m/44'/60'/0'/0/${i}`,   // Ethereum (+ ERC-20)
  TRON: (i: number) => `m/44'/195'/0'/0/${i}`,  // TRON (+ TRC-20)
} as const;

export type Chain = 'BTC' | 'ETH' | 'TRON';

export interface DerivedAddress {
  chain: Chain;
  index: number;
  path: string;
  address: string;
  // فقط برای chain='BTC' مقدار داره. default = 'segwit'.
  btcAddressType?: BtcAddressType;
}

// ─────────────────────────── Mnemonic ───────────────────────────

export function generateMnemonic(wordCount: 12 | 24 = 12): string {
  const strength = wordCount === 24 ? 256 : 128;
  return bip39.generateMnemonic(strength);
}

/**
 * نرمال‌سازی استاندارد برای mnemonic کاربر (BIP39 §3.1):
 *   - NFKD: compatibility decomposition (NBSP U+00A0 → SPACE و …)
 *   - strip zero-width chars: U+200B/C/D، U+FEFF (BOM)، U+2060 — اینا تو \s نیستن
 *     و از copy/paste اپ‌های دیگه راحت وارد می‌شن.
 *   - trim + collapse whitespace: tab/newline/multi-space → single space
 *   - lowercase: wordlist انگلیسی bip39 همه‌ش lowercase ست.
 *
 * بدون این pipeline، یه رشته‌ی ظاهراً یکسان ممکنه ظاهری OK باشه ولی seed
 * متفاوت بده (PBKDF2 روی بایت‌های خام اجرا می‌شه).
 */
// U+200B..U+200D (zero-width space / non-joiner / joiner), U+2060 (word joiner),
// U+FEFF (BOM / zero-width no-break space). هیچ‌کدوم تو \s نیستن.
const ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;

export function normalizeMnemonic(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(ZERO_WIDTH_CHARS, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function isValidMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(normalizeMnemonic(mnemonic));
}

/**
 * نسخه‌ی بهینه برای benchmark (loop داغ).
 *
 * entropy و یه buffer داخلی رو بعد از مصرف overwrite می‌کنیم. خود string
 * مnemonic رو نمی‌تونیم wipe کنیم (immutable در JS) ولی reference رو رها
 * می‌کنیم تا GC جمعش کنه. این بهترین کاری هست که در محیط ManagedJS می‌شه
 * انجام داد.
 */
export interface BenchmarkMnemonicHandle {
  mnemonic: string;
  wipe: () => void;
}

export function generateMnemonicForBenchmark(
  wordCount: 12 | 24 = 12
): BenchmarkMnemonicHandle {
  const strength = wordCount === 24 ? 256 : 128;
  const entropy = randomBytes(strength / 8);
  const mnemonic = bip39.entropyToMnemonic(entropy);

  return {
    mnemonic,
    wipe(): void {
      randomFillSync(entropy);
      entropy.fill(0);
    },
  };
}

// ─────────────────────────── Single-address derivation ───────────────────────────

/**
 * از mnemonic یه آدرس برای chain + index مشخص می‌سازه.
 * برای derivation یک‌بارمصرف خوبه، ولی برای batch از `deriveMany` استفاده کن.
 */
export async function deriveAddress(
  mnemonic: string,
  chain: Chain,
  index: number,
  passphrase: string = ''
): Promise<DerivedAddress> {
  const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
  const root = bip32.fromSeed(seed);
  return deriveFromRoot(root, chain, index);
}

// ─────────────────────────── Batch derivation (مهم برای scale) ───────────────────────────

export interface DeriveManyRequest {
  chain: Chain;
  fromIndex: number;
  count: number;
}

/**
 * با یه bar parse mnemonic، چند تا آدرس برای چند chain می‌سازه.
 * استفاده: تولید ۱۰ تا BTC + ۱۰ تا ETH + ۱۰ تا TRON تو یه تابع.
 *
 * این بهینه‌ست چون PBKDF2 فقط یه بار اجرا می‌شه (که خودش ۲۰۴۸ iteration HMAC هست).
 */
export async function deriveMany(
  mnemonic: string,
  requests: DeriveManyRequest[],
  passphrase: string = ''
): Promise<DerivedAddress[]> {
  const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
  const root = bip32.fromSeed(seed);

  const results: DerivedAddress[] = [];
  for (const req of requests) {
    for (let i = 0; i < req.count; i++) {
      const idx = req.fromIndex + i;
      results.push(deriveFromRoot(root, req.chain, idx));
    }
  }
  return results;
}

// ─────────────────────────── Core derivation logic ───────────────────────────

function deriveFromRoot(
  root: BIP32Interface,
  chain: Chain,
  index: number,
): DerivedAddress {
  if (chain === 'BTC') return deriveBtcFromRoot(root, 'segwit', index);

  const path = PATHS[chain](index);
  const node = root.derivePath(path);

  switch (chain) {
    case 'ETH': {
      // BIP32 قطعی‌ست، پس نتیجه دقیقاً برابر MetaMask/Trust Wallet می‌شه.
      // getAddress از ethers همون EIP-55 checksum رو اعمال می‌کنه.
      const last20 = keccakLast20Hex(node.publicKey);
      return { chain, index, path, address: getAddress('0x' + last20) };
    }

    case 'TRON': {
      const last20 = keccakLast20Hex(node.publicKey);
      const payload = Buffer.concat([
        Buffer.from([0x41]),             // TRON mainnet prefix
        Buffer.from(last20, 'hex'),
      ]);
      return { chain, index, path, address: bs58check.encode(payload) };
    }
  }
}

function deriveBtcFromRoot(
  root: BIP32Interface,
  type: BtcAddressType,
  index: number
): DerivedAddress {
  const path = BTC_PATHS[type](index);
  const node = root.derivePath(path);
  const pubkey = Buffer.from(node.publicKey);
  const network = bitcoin.networks.bitcoin;

  let address: string | undefined;
  switch (type) {
    case 'legacy': {
      address = bitcoin.payments.p2pkh({ pubkey, network }).address;
      break;
    }
    case 'p2sh': {
      const redeem = bitcoin.payments.p2wpkh({ pubkey, network });
      address = bitcoin.payments.p2sh({ redeem, network }).address;
      break;
    }
    case 'segwit': {
      address = bitcoin.payments.p2wpkh({ pubkey, network }).address;
      break;
    }
  }
  if (!address) throw new Error(`BTC address derivation failed for type=${type}`);

  return { chain: 'BTC', index, path, address, btcAddressType: type };
}

/**
 * برای import و balance scan: هر ۳ نوع آدرس BTC (legacy, p2sh, segwit) رو
 * از یه mnemonic می‌سازه. یه بار seed → root parse می‌شه (PBKDF2 گرون)
 * و بقیه derivation سریع از root میاد.
 *
 * مثال: count=5 → 15 آدرس (۵ × ۳ نوع) می‌ده.
 */
export async function deriveBtcAllTypes(
  mnemonic: string,
  fromIndex: number,
  count: number,
  passphrase: string = ''
): Promise<DerivedAddress[]> {
  if (count < 0) throw new Error('count نباید منفی باشه');
  if (count === 0) return [];

  const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
  const root = bip32.fromSeed(seed);

  const results: DerivedAddress[] = [];
  for (const type of BTC_ADDRESS_TYPES) {
    for (let i = 0; i < count; i++) {
      results.push(deriveBtcFromRoot(root, type, fromIndex + i));
    }
  }
  return results;
}

function keccakLast20Hex(compressedPubKey: Uint8Array): string {
  const uncompressed = ecc.pointCompress(compressedPubKey, false);
  if (!uncompressed) throw new Error('pubkey decompression failed');

  const xy = uncompressed.slice(1); // drop 0x04 prefix
  const hashHex = keccak256(xy);     // "0x" + 64 hex chars
  return hashHex.slice(26);          // last 20 bytes = 40 hex chars
}
