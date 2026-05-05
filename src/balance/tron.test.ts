/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTronBalance, addressToParam } from './tron.js';

const KNOWN_HOLDER = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9';
const KNOWN_HOLDER_PARAM =
  '00000000000000000000000082dd6b9966724ae2fdc79b416c7588da67ff1b35';

describe('addressToParam', () => {
  it('encodes a Tron address to 64-hex ABI parameter (no 0x, no 0x41 prefix)', () => {
    const param = addressToParam(KNOWN_HOLDER);
    assert.equal(param.length, 64);
    assert.equal(param, KNOWN_HOLDER_PARAM);
  });

  it('rejects non-base58 input', () => {
    assert.throws(() => addressToParam('not-a-real-tron-address'));
  });
});

describe('getTronBalance — fresh account (mocked)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 0n for both TRX and USDT when getaccount omits the balance field', async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/wallet/getaccount')) {
        return new Response('{}', { status: 200 });
      }
      if (u.endsWith('/wallet/triggerconstantcontract')) {
        return new Response(
          JSON.stringify({
            result: { result: true },
            constant_result: ['0'.repeat(64)],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof globalThis.fetch;

    const result = await getTronBalance(KNOWN_HOLDER);
    assert.equal(result.address, KNOWN_HOLDER);
    assert.equal(result.trx, 0n);
    assert.equal(result.usdt, 0n);
  });
});

// Live mainnet integration test. Gated by env var because public RPCs are
// flaky and CI may run offline. Run manually with:
//   TRON_INTEGRATION=1 npm test
const integrationDescribe = process.env.TRON_INTEGRATION ? describe : describe.skip;

integrationDescribe('getTronBalance — live mainnet', () => {
  it('returns non-zero TRX and USDT for a known holder', async () => {
    const result = await getTronBalance(KNOWN_HOLDER);
    assert.ok(result.trx > 0n, `expected non-zero TRX, got ${result.trx}`);
    assert.ok(result.usdt > 0n, `expected non-zero USDT, got ${result.usdt}`);
  });
});
