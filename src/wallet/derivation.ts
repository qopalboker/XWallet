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
import { HDNodeWallet, keccak256 } from 'ethers';
import bs58check from 'bs58check';
import { randomBytes, randomFillSync } from 'node:crypto';

const bip32 = BIP32Factory(ecc);

// ─── Derivation paths (Trust Wallet standard) ───
export const PATHS = {
  BTC: (i: number)  => `m/84'/0'/0'/0/${i}`,    // Native SegWit (bc1…)
  ETH: (i: number)  => `m/44'/60'/0'/0/${i}`,   // Ethereum (+ ERC-20)
  TRON: (i: number) => `m/44'/195'/0'/0/${i}`,  // TRON (+ TRC-20)
} as const;

export type Chain = 'BTC' | 'ETH' | 'TRON';

export interface DerivedAddress {
  chain: Chain;
  index: number;
  path: string;
  address: string;
}

// ─────────────────────────── Mnemonic ───────────────────────────

export function generateMnemonic(wordCount: 12 | 24 = 12): string {
  const strength = wordCount === 24 ? 256 : 128;
  return bip39.generateMnemonic(strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic.trim().toLowerCase());
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
  return deriveFromRoot(root, chain, index, mnemonic, passphrase);
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
      results.push(deriveFromRoot(root, req.chain, idx, mnemonic, passphrase));
    }
  }
  return results;
}

// ─────────────────────────── Core derivation logic ───────────────────────────

function deriveFromRoot(
  root: BIP32Interface,
  chain: Chain,
  index: number,
  mnemonic: string,
  passphrase: string
): DerivedAddress {
  const path = PATHS[chain](index);

  switch (chain) {
    case 'BTC': {
      const node = root.derivePath(path);
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(node.publicKey),
        network: bitcoin.networks.bitcoin,
      });
      return { chain, index, path, address: address! };
    }

    case 'ETH': {
      // ethers خودش HD derivation داره؛ از همون استفاده می‌کنیم
      // برای consistency با MetaMask
      const wallet = HDNodeWallet.fromPhrase(mnemonic, passphrase, path);
      return { chain, index, path, address: wallet.address };
    }

    case 'TRON': {
      const node = root.derivePath(path);
      const address = tronAddressFromPubKey(node.publicKey);
      return { chain, index, path, address };
    }
  }
}

function tronAddressFromPubKey(compressedPubKey: Uint8Array): string {
  const uncompressed = ecc.pointCompress(compressedPubKey, false);
  if (!uncompressed) throw new Error('pubkey decompression failed');

  const xy = uncompressed.slice(1); // drop 0x04 prefix
  const hashHex = keccak256(xy);     // "0x" + 64 hex chars
  const last20 = hashHex.slice(26);  // last 20 bytes = 40 hex chars

  const payload = Buffer.concat([
    Buffer.from([0x41]),             // TRON mainnet prefix
    Buffer.from(last20, 'hex'),
  ]);

  return bs58check.encode(payload);
}
