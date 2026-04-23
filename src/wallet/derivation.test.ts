/**
 * BIP39 test vectors — حیاتی‌ترین تست کیف‌پوله.
 *
 * mnemonic "abandon abandon … about" مشهورترین vector استاندارده و آدرس‌هاش
 * تو Ian Coleman's BIP39 tool، Trust Wallet، MetaMask، Electrum و ledger
 * دقیقاً یکسانه. اگه هر کدوم از آدرس‌ها mismatch بده، یعنی کاربر با mnemonic
 * درست، آدرسی متفاوت از بقیه ولت‌ها می‌گیره — یعنی "پول گم می‌شه".
 *
 * این تست قبل از production باید سبز باشه؛ اگه یه روز dependency زیرین (bip32,
 * bitcoinjs, ethers, bs58check) رفتار بد داد، همین‌جا می‌فهمیم.
 */

/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAddress,
  deriveMany,
  deriveBtcAllTypes,
  isValidMnemonic,
  normalizeMnemonic,
  BTC_PATHS,
  PATHS,
} from './derivation.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// zero-width characters که از clipboard بعضی اپ‌ها کپی می‌شن و به چشم
// دیده نمی‌شن. اگه normalize پاکشون نکنه، mnemonic ظاهراً درست ولی از
// نظر بایتی متفاوت می‌شه و seed اشتباه می‌ده.
const ZWSP = '​';
const ZWNJ = '‌';
const ZWJ  = '‍';
const BOM  = '﻿';
const NBSP = ' ';

// مقادیر مرجع مستقل — با چندین ولت رایج (Trust, MetaMask, Electrum،
// TronLink) تطبیق داده شدن. اگه این‌ها تغییر کنن، یعنی derivation ما با
// بقیهٔ جهان هم‌راستا نیست.
const EXPECTED = {
  // m/84'/0'/0'/0/0 — Native SegWit (default)
  BTC_SEGWIT_0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  // m/49'/0'/0'/0/0 — P2SH-wrapped SegWit
  BTC_P2SH_0:   '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
  // m/44'/0'/0'/0/0 — Legacy P2PKH
  BTC_LEGACY_0: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
  // m/44'/60'/0'/0/0 — Ethereum (EIP-55 checksum)
  ETH_0:        '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  // m/44'/195'/0'/0/0 — TRON. مکانیسم: keccak256(pubkey_xy) → last20 →
  // prefix 0x41 → bs58check. همون منطق ETH با prefix متفاوت.
  TRON_0:       'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
} as const;

describe('BIP39 vector — abandon × 11 + about', () => {
  it('mnemonic خودش معتبره (checksum OK)', () => {
    assert.equal(isValidMnemonic(MNEMONIC), true);
  });

  it('BTC segwit (m/84\'/0\'/0\'/0/0) با ولت‌های اصلی match می‌کنه', async () => {
    const a = await deriveAddress(MNEMONIC, 'BTC', 0);
    assert.equal(a.address, EXPECTED.BTC_SEGWIT_0);
    assert.equal(a.path, PATHS.BTC(0));
    assert.equal(a.btcAddressType, 'segwit');
  });

  it('ETH (m/44\'/60\'/0\'/0/0) با MetaMask/Trust match می‌کنه', async () => {
    const a = await deriveAddress(MNEMONIC, 'ETH', 0);
    assert.equal(a.address, EXPECTED.ETH_0);
    assert.equal(a.path, PATHS.ETH(0));
  });

  it('TRON (m/44\'/195\'/0\'/0/0) با TronLink match می‌کنه', async () => {
    const a = await deriveAddress(MNEMONIC, 'TRON', 0);
    assert.equal(a.address, EXPECTED.TRON_0);
    assert.equal(a.path, PATHS.TRON(0));
  });
});

describe('BTC multi-path derivation (import compatibility)', () => {
  it('هر ۳ نوع آدرس BTC با vector مرجع match می‌کنن', async () => {
    const all = await deriveBtcAllTypes(MNEMONIC, 0, 1);
    // انتظار داریم ۳ آدرس (یکی per type) برگرده
    assert.equal(all.length, 3);

    const byType = Object.fromEntries(all.map((a) => [a.btcAddressType!, a]));

    assert.equal(byType.segwit.address, EXPECTED.BTC_SEGWIT_0);
    assert.equal(byType.segwit.path, BTC_PATHS.segwit(0));

    assert.equal(byType.p2sh.address, EXPECTED.BTC_P2SH_0);
    assert.equal(byType.p2sh.path, BTC_PATHS.p2sh(0));

    assert.equal(byType.legacy.address, EXPECTED.BTC_LEGACY_0);
    assert.equal(byType.legacy.path, BTC_PATHS.legacy(0));
  });

  it('deriveBtcAllTypes با count=0 آرایهٔ خالی برمی‌گردونه', async () => {
    const all = await deriveBtcAllTypes(MNEMONIC, 0, 0);
    assert.deepEqual(all, []);
  });

  it('deriveBtcAllTypes با count=3 → 9 آدرس (۳ نوع × ۳ index)', async () => {
    const all = await deriveBtcAllTypes(MNEMONIC, 0, 3);
    assert.equal(all.length, 9);
    for (const a of all) {
      assert.equal(a.chain, 'BTC');
      assert.ok(a.btcAddressType === 'segwit' || a.btcAddressType === 'p2sh' || a.btcAddressType === 'legacy');
    }
    // آدرس‌ها نباید هیچ duplicate ای داشته باشن (۳ نوع × ۳ index = ۹ آدرس یکتا)
    const uniq = new Set(all.map((a) => a.address));
    assert.equal(uniq.size, 9);
  });

  it('deriveBtcAllTypes با count منفی خطا می‌ده', async () => {
    await assert.rejects(() => deriveBtcAllTypes(MNEMONIC, 0, -1), /count/);
  });
});

describe('normalizeMnemonic', () => {
  it('NFKD: NBSP (U+00A0) رو به space ساده تبدیل می‌کنه', () => {
    const nbsp = MNEMONIC.split(' ').join(NBSP);
    assert.equal(normalizeMnemonic(nbsp), MNEMONIC);
  });

  it('zero-width chars (U+200B..U+200D, U+FEFF) بین فاصله‌ها پاک می‌شن', () => {
    // هر zero-width بعد از یه space واقعی میاد (رایج‌ترین حالت از copy/paste)
    const polluted = MNEMONIC
      .split(' ')
      .map((w, i) => {
        if (i === 0) return w;
        const zw = [ZWSP, ZWNJ, ZWJ, BOM][i % 4];
        return zw + w;
      })
      .join(' ');
    assert.equal(normalizeMnemonic(polluted), MNEMONIC);
  });

  it('whitespace اضافه/tab/newline رو جمع می‌کنه', () => {
    const messy = '  abandon\tabandon\nabandon  abandon abandon abandon abandon abandon abandon abandon abandon about  ';
    assert.equal(normalizeMnemonic(messy), MNEMONIC);
  });

  it('uppercase رو به lowercase می‌بره', () => {
    const upper = MNEMONIC.toUpperCase();
    assert.equal(normalizeMnemonic(upper), MNEMONIC);
  });

  it('polluted mnemonic بعد از normalize معتبر باشه', () => {
    // ترکیب NBSP + zero-width + uppercase + trailing tab — معمولاً از
    // copy/paste UI های دیگه میان. همه باید قبل از validation پاک بشن.
    const words = MNEMONIC.split(' ');
    const polluted = '  ' +
      words
        .map((w, i) => (i === 5 ? ZWSP + w.toUpperCase() : w))
        .join(NBSP) +
      '\t';
    assert.equal(isValidMnemonic(polluted), true);
  });
});

describe('deriveMany (batch)', () => {
  it('BTC default path segwit هست (backwards compat)', async () => {
    const [a] = await deriveMany(MNEMONIC, [{ chain: 'BTC', fromIndex: 0, count: 1 }]);
    assert.equal(a.address, EXPECTED.BTC_SEGWIT_0);
    assert.equal(a.btcAddressType, 'segwit');
  });

  it('multi-chain یه ترتیبه request ها رو حفظ می‌کنه', async () => {
    const res = await deriveMany(MNEMONIC, [
      { chain: 'BTC', fromIndex: 0, count: 1 },
      { chain: 'ETH', fromIndex: 0, count: 1 },
      { chain: 'TRON', fromIndex: 0, count: 1 },
    ]);
    assert.equal(res.length, 3);
    assert.equal(res[0].address, EXPECTED.BTC_SEGWIT_0);
    assert.equal(res[1].address, EXPECTED.ETH_0);
    assert.equal(res[2].address, EXPECTED.TRON_0);
  });
});

describe('BIP39 passphrase (اختیاری — 25th word)', () => {
  it('passphrase مختلف → seed و آدرس متفاوت', async () => {
    const withPass = await deriveAddress(MNEMONIC, 'ETH', 0, 'TREZOR');
    const noPass = await deriveAddress(MNEMONIC, 'ETH', 0);
    assert.notEqual(withPass.address, noPass.address);
  });
});
