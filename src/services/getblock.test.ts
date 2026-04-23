/**
 * Smoke tests ساده با node:test (بدون فریم‌ورک اضافی).
 * اجرا: npm test
 */

/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidGetBlockToken,
  redactGetBlockUrl,
  parseConfig,
  providerForEntry,
  buildEndpointUrl,
  resolveRegion,
  verifyRegionOnBoot,
  __resetActiveRegionForTests,
} from './getblock.js';

describe('isValidGetBlockToken', () => {
  it('accepts 32 lower-case hex', () => {
    assert.equal(isValidGetBlockToken('499ae68ced964da691b52dbbc40a65b9'), true);
  });
  it('accepts 32 upper-case hex (case-insensitive)', () => {
    assert.equal(isValidGetBlockToken('ABCDEF1234567890ABCDEF1234567890'), true);
  });
  it('rejects too short', () => {
    assert.equal(isValidGetBlockToken('deadbeef'), false);
  });
  it('rejects tokens with dashes', () => {
    assert.equal(isValidGetBlockToken('499ae68c-ed96-4da6-91b5-2dbbc40a65b9'), false);
  });
  it('rejects empty string', () => {
    assert.equal(isValidGetBlockToken(''), false);
  });
  it('rejects non-string input', () => {
    assert.equal(isValidGetBlockToken(123 as unknown as string), false);
    assert.equal(isValidGetBlockToken(null as unknown as string), false);
    assert.equal(isValidGetBlockToken(undefined as unknown as string), false);
  });
});

describe('redactGetBlockUrl', () => {
  it('redacts token in go.getblock.io URL', () => {
    assert.equal(
      redactGetBlockUrl('https://go.getblock.io/499ae68ced964da691b52dbbc40a65b9/'),
      'https://go.getblock.io/499ae68c…/'
    );
  });
  it('redacts tokens in go.getblock.us/asia URLs', () => {
    assert.equal(
      redactGetBlockUrl('https://go.getblock.us/abcdef1234567890abcdef1234567890/'),
      'https://go.getblock.us/abcdef12…/'
    );
    assert.equal(
      redactGetBlockUrl('https://go.getblock.asia/abcdef1234567890abcdef1234567890/'),
      'https://go.getblock.asia/abcdef12…/'
    );
  });
  it('redacts URL without trailing slash', () => {
    assert.equal(
      redactGetBlockUrl('https://go.getblock.io/499ae68ced964da691b52dbbc40a65b9'),
      'https://go.getblock.io/499ae68c…'
    );
  });
  it('leaves non-GetBlock URLs alone', () => {
    assert.equal(
      redactGetBlockUrl('https://eth.llamarpc.com/'),
      'https://eth.llamarpc.com/'
    );
  });
  it('redacts when embedded in error message', () => {
    const msg = 'fetch failed https://go.getblock.io/499ae68ced964da691b52dbbc40a65b9/ with 429';
    assert.equal(
      redactGetBlockUrl(msg),
      'fetch failed https://go.getblock.io/499ae68c…/ with 429'
    );
  });
});

describe('parseConfig', () => {
  it('parses the sample shared config (btc + eth mainnet)', () => {
    const raw = {
      shared: {
        btc: { mainnet: { jsonRpc: ['499ae68ced964da691b52dbbc40a65b9'] } },
        eth: { mainnet: { jsonRpc: ['0c00bf76cba14a4e9474d75d85967d0d'] } },
      },
    };
    const entries = parseConfig(raw);
    assert.equal(entries.length, 2);
    const eth = entries.find((e) => e.chain === 'eth')!;
    assert.equal(eth.network, 'mainnet');
    assert.equal(eth.rpcType, 'jsonRpc');
    assert.equal(eth.token, '0c00bf76cba14a4e9474d75d85967d0d');
  });

  it('accepts string input', () => {
    const raw = JSON.stringify({
      shared: { eth: { mainnet: { jsonRpc: ['abcdef1234567890abcdef1234567890'] } } },
    });
    assert.equal(parseConfig(raw).length, 1);
  });
});

describe('providerForEntry', () => {
  it('maps eth mainnet jsonRpc → eth_rpc', () => {
    assert.equal(
      providerForEntry({ chain: 'eth', network: 'mainnet', rpcType: 'jsonRpc', token: 'x' }),
      'eth_rpc'
    );
  });
  it('returns null for btc (TODO until broadcast wired)', () => {
    assert.equal(
      providerForEntry({ chain: 'btc', network: 'mainnet', rpcType: 'jsonRpc', token: 'x' }),
      null
    );
  });
  it('returns null for testnet', () => {
    assert.equal(
      providerForEntry({ chain: 'eth', network: 'testnet', rpcType: 'jsonRpc', token: 'x' }),
      null
    );
  });
  it('returns null for non-jsonRpc types', () => {
    assert.equal(
      providerForEntry({ chain: 'eth', network: 'mainnet', rpcType: 'rest', token: 'x' }),
      null
    );
  });
});

describe('buildEndpointUrl', () => {
  it('builds io URL by default', () => {
    const url = buildEndpointUrl('499ae68ced964da691b52dbbc40a65b9', 'io');
    assert.equal(url, 'https://go.getblock.io/499ae68ced964da691b52dbbc40a65b9/');
  });
  it('rejects invalid tokens', () => {
    assert.throws(() => buildEndpointUrl('not-hex', 'io'));
    assert.throws(() => buildEndpointUrl('abcdef', 'io'));
  });
});

describe('region resolution persistence', () => {
  const VALID = '499ae68ced964da691b52dbbc40a65b9';

  it('resolveRegion falls back to env when activeRegion is null', () => {
    __resetActiveRegionForTests();
    const saved = process.env.GETBLOCK_REGION;
    process.env.GETBLOCK_REGION = 'us';
    try {
      assert.equal(resolveRegion(), 'us');
      assert.equal(buildEndpointUrl(VALID), `https://go.getblock.us/${VALID}/`);
    } finally {
      process.env.GETBLOCK_REGION = saved;
      __resetActiveRegionForTests();
    }
  });

  it('verifyRegionOnBoot overrides env when preferred is unreachable (runtime اثر می‌گذاره)', async () => {
    __resetActiveRegionForTests();
    const saved = process.env.GETBLOCK_REGION;
    process.env.GETBLOCK_REGION = 'us';

    // شبیه‌سازی اینکه preferred unreachable هست ولی 'io' ok هست
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string | URL) => {
      const s = typeof url === 'string' ? url : url.toString();
      if (s.startsWith('https://go.getblock.us')) {
        return Promise.reject(new Error('ENOTFOUND'));
      }
      return Promise.resolve(new Response('', { status: 403 }));
    }) as typeof fetch;

    try {
      const logs: string[] = [];
      const log = {
        info: (m: string) => logs.push(`INFO ${m}`),
        warn: (m: string) => logs.push(`WARN ${m}`),
      };
      const chosen = await verifyRegionOnBoot(log, { recheckIntervalMs: null });
      assert.equal(chosen, 'io');

      // مهم‌ترین assertion: runtime URL باید از 'io' استفاده کنه
      // (fallback واقعاً apply شده — نه فقط لاگ)
      assert.equal(resolveRegion(), 'io');
      assert.equal(buildEndpointUrl(VALID), `https://go.getblock.io/${VALID}/`);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.GETBLOCK_REGION = saved;
      __resetActiveRegionForTests();
    }
  });
});
