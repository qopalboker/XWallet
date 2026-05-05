/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTronBalance, addressToParam, _resetTronCache } from './tron.js';

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
    _resetTronCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetTronCache();
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

describe('getTronBalance — fallback (mocked)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetTronCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetTronCache();
  });

  it('falls back from tronstack 5xx to trongrid and returns the trongrid result', async () => {
    const callsByHost: Record<string, number> = {};

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const u = String(url);
      const host = new URL(u).host;
      callsByHost[host] = (callsByHost[host] ?? 0) + 1;

      if (host === 'api.tronstack.io') {
        return new Response('upstream error', { status: 503 });
      }
      if (host === 'api.trongrid.io') {
        if (u.endsWith('/wallet/getaccount')) {
          return new Response(JSON.stringify({ balance: 35216519 }), { status: 200 });
        }
        if (u.endsWith('/wallet/triggerconstantcontract')) {
          return new Response(
            JSON.stringify({
              result: { result: true },
              constant_result: ['0'.repeat(58) + '2f4d60'],
            }),
            { status: 200 },
          );
        }
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof globalThis.fetch;

    const result = await getTronBalance(KNOWN_HOLDER);
    assert.equal(result.trx, 35216519n);
    assert.equal(result.usdt, 0x2f4d60n);
    assert.ok(callsByHost['api.tronstack.io'] >= 1, 'primary should be attempted');
    assert.ok(callsByHost['api.trongrid.io'] >= 1, 'fallback should be attempted');
  });

  it('does NOT fall back on 4xx — propagates the error', async () => {
    let trongridCalls = 0;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const u = String(url);
      const host = new URL(u).host;
      if (host === 'api.trongrid.io') trongridCalls += 1;
      return new Response('bad request', { status: 400 });
    }) as typeof globalThis.fetch;

    await assert.rejects(() => getTronBalance(KNOWN_HOLDER), /400/);
    assert.equal(trongridCalls, 0, 'fallback must not be attempted on 4xx');
  });
});

describe('getTronBalance — cache (mocked)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetTronCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetTronCache();
  });

  it('serves the second call within TTL from cache without hitting the network', async () => {
    let networkCalls = 0;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      networkCalls += 1;
      const u = String(url);
      if (u.endsWith('/wallet/getaccount')) {
        return new Response(JSON.stringify({ balance: 42 }), { status: 200 });
      }
      if (u.endsWith('/wallet/triggerconstantcontract')) {
        return new Response(
          JSON.stringify({
            result: { result: true },
            constant_result: ['0'.repeat(62) + '7b'],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof globalThis.fetch;

    const first = await getTronBalance(KNOWN_HOLDER);
    const callsAfterFirst = networkCalls;
    const second = await getTronBalance(KNOWN_HOLDER);

    assert.equal(first.trx, 42n);
    assert.equal(first.usdt, 0x7bn);
    assert.deepEqual(second, first);
    assert.equal(callsAfterFirst, 2, 'first call issues both /wallet/* requests');
    assert.equal(networkCalls, 2, 'second call must not touch the network');
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
