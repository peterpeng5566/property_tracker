// tests/yahoo.test.js — lib/yahoo.js tests (Node, no jsdom).
//
// Run: ./test.sh (auto-discovers this file).
//
// Tests cover the public API contract:
//   - fetchQuotes(symbols, fetchFn) — batch per-symbol fetch via chart endpoint
//   - Error classes exported correctly
//   - URL routing via PORTFOLIO_CONFIG.yahooProxyUrl
//
// All fetch calls are mocked via fetchFn injection — no real network.
// PORTFOLIO_CONFIG is set on globalThis to match the IIFE's root-detection.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Yahoo = require('../lib/yahoo.js');
const { fetchQuotes, YahooAuthError, YahooNetworkError, YahooParseError } = Yahoo;

// Setup: ensure PORTFOLIO_CONFIG is reachable via globalThis (Node mode).
// Tests can override yahooProxyUrl via globalThis.PORTFOLIO_CONFIG.yahooProxyUrl.
globalThis.PORTFOLIO_CONFIG = { yahooProxyUrl: '' };

// ===== Test helpers =====

// Mock Response shape (subset of fetch Response that lib/yahoo.js uses):
//   { ok: boolean, status: number, json: () => Promise<object> }
function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Build a Yahoo chart endpoint response shape for a given symbol + meta values.
function chartResponse(symbol, overrides = {}) {
  const meta = {
    currency: 'USD',
    symbol,
    instrumentType: 'EQUITY',
    regularMarketPrice: 100.0,
    fiftyTwoWeekHigh: 150.0,
    fiftyTwoWeekLow: 80.0,
    regularMarketDayHigh: 105.0,
    regularMarketDayLow: 95.0,
    regularMarketVolume: 1000000,
    chartPreviousClose: 99.0,
    regularMarketTime: Math.floor(Date.now() / 1000),
    gmtoffset: 0,
    timezone: 'UTC',
    currentTradingPeriod: {
      pre:    { start: 0, end: 0 },
      regular: { start: 0, end: 9999999999 },
      post:   { start: 0, end: 0 },
    },
    ...overrides,
  };
  return {
    chart: {
      result: [{ meta }],
      error: null,
    },
  };
}

// Build a mock fetchFn that records every URL it was called with and returns
// the appropriate canned response.
function makeFetchFn(handlers) {
  // handlers: { [symbol]: Response | (() => Response) }
  const calls = [];
  return {
    fetchFn: async (url) => {
      calls.push(url);
      // Decode the URL so handler keys with special chars (like TWD=X) match.
      const decoded = decodeURIComponent(url);
      for (const [key, value] of Object.entries(handlers)) {
        if (decoded.includes(key) || url.includes(key)) {
          return typeof value === 'function' ? value() : value;
        }
      }
      throw new Error(`mock fetchFn: no handler for ${url}`);
    },
    calls,
  };
}

// ===== Tests =====

test('fetchQuotes: empty symbols array returns empty object (no fetches)', async () => {
  const { fetchFn, calls } = makeFetchFn({});
  const out = await fetchQuotes([], fetchFn);
  assert.deepEqual(out, {});
  assert.equal(calls.length, 0);
});

test('fetchQuotes: falls back to global fetch when fetchFn not provided', async () => {
  // Node 21+ exposes fetch globally. When fetchFn is omitted, the lib
  // should use that global fetch — which we intercept by temporarily
  // deleting it.
  const savedFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (url) => {
    called = true;
    return mockResponse(chartResponse('AAPL'));
  };
  try {
    const out = await fetchQuotes(['AAPL']);
    assert.equal(called, true);
    assert.ok(out.AAPL);
  } finally {
    if (savedFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = savedFetch;
  }
});

test('fetchQuotes: throws YahooAuthError when no fetchFn and no global fetch', async () => {
  const savedFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    await assert.rejects(
      () => fetchQuotes(['AAPL']),
      (err) => err instanceof YahooAuthError && err.message.includes('fetch')
    );
  } finally {
    if (savedFetch !== undefined) globalThis.fetch = savedFetch;
  }
});

test('fetchQuotes: throws YahooAuthError when symbols not array', async () => {
  const { fetchFn } = makeFetchFn({});
  await assert.rejects(
    () => fetchQuotes('AAPL', fetchFn),
    (err) => err instanceof YahooAuthError && err.message.includes('array')
  );
});

test('fetchQuotes: single symbol success maps fields correctly', async () => {
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL', {
      regularMarketPrice: 225.50,
      fiftyTwoWeekHigh: 250.0,
      fiftyTwoWeekLow: 180.0,
      chartPreviousClose: 223.0,
    })),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.current_price, 225.50);
  assert.equal(out.AAPL.high_52w, 250.0);
  assert.equal(out.AAPL.low_52w, 180.0);
  assert.equal(out.AAPL.prev_close, 223.0);
  assert.equal(out.AAPL.currency, 'USD');
  assert.ok(typeof out.AAPL.marketState === 'string');
  // Should NOT propagate unwanted fields
  assert.equal(out.AAPL.symbol, undefined);
  assert.equal(out.AAPL.regularMarketVolume, undefined);
});

test('fetchQuotes: multiple symbols all succeed (parallel)', async () => {
  const { fetchFn, calls } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL', { regularMarketPrice: 200 })),
    MSFT: mockResponse(chartResponse('MSFT', { regularMarketPrice: 400 })),
    GOOG: mockResponse(chartResponse('GOOG', { regularMarketPrice: 150 })),
  });
  const out = await fetchQuotes(['AAPL', 'MSFT', 'GOOG'], fetchFn);
  assert.equal(out.AAPL.current_price, 200);
  assert.equal(out.MSFT.current_price, 400);
  assert.equal(out.GOOG.current_price, 150);
  assert.equal(calls.length, 3);
});

test('fetchQuotes: one symbol 404 → failed: true, others succeed', async () => {
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL'), 200),
    BAD: mockResponse({ chart: { result: null, error: { code: 'Not Found' } } }, 404),
    MSFT: mockResponse(chartResponse('MSFT', { regularMarketPrice: 400 }), 200),
  });
  const out = await fetchQuotes(['AAPL', 'BAD', 'MSFT'], fetchFn);
  assert.equal(out.AAPL.current_price, 100);
  assert.equal(out.BAD.failed, true);
  assert.equal(out.MSFT.current_price, 400);
});

test('fetchQuotes: 500 response → failed: true (not throw)', async () => {
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse({}, 500),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.failed, true);
});

test('fetchQuotes: malformed JSON → failed: true', async () => {
  const { fetchFn } = makeFetchFn({
    AAPL: {
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    },
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.failed, true);
});

test('fetchQuotes: empty results array → failed: true', async () => {
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse({ chart: { result: [], error: null } }),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.failed, true);
});

test('fetchQuotes: FX symbol (TWD=X) returns CURRENCY instrumentType', async () => {
  const { fetchFn } = makeFetchFn({
    'TWD=X': mockResponse(chartResponse('TWD=X', {
      currency: 'TWD',
      instrumentType: 'CURRENCY',
      regularMarketPrice: 32.5,
      chartPreviousClose: 32.4,
    })),
  });
  const out = await fetchQuotes(['TWD=X'], fetchFn);
  assert.equal(out['TWD=X'].current_price, 32.5);
  assert.equal(out['TWD=X'].currency, 'TWD');
  // FX never reports intraday (always 'CLOSED' per deriveMarketState)
  assert.equal(out['TWD=X'].marketState, 'CLOSED');
});

test('fetchQuotes: marketState derived correctly for REGULAR session', async () => {
  // Now is in the middle of a regular session that started 1 hour ago
  // and ends 5 hours from now.
  const now = Math.floor(Date.now() / 1000);
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL', {
      currentTradingPeriod: {
        pre:    { start: now - 7200, end: now - 3600 },
        regular: { start: now - 3600, end: now + 18000 },
        post:   { start: now + 18000, end: now + 28800 },
      },
    })),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.marketState, 'REGULAR');
});

test('fetchQuotes: marketState PRE for pre-market', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL', {
      currentTradingPeriod: {
        pre:    { start: now - 1800, end: now + 1800 },
        regular: { start: now + 1800, end: now + 18000 },
        post:   { start: now + 18000, end: now + 28800 },
      },
    })),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.marketState, 'PRE');
});

test('fetchQuotes: marketState CLOSED when outside all sessions', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { fetchFn } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL', {
      currentTradingPeriod: {
        pre:    { start: now - 100000, end: now - 50000 },
        regular: { start: now - 50000, end: now - 10000 },
        post:   { start: now - 10000, end: now - 1000 },
      },
    })),
  });
  const out = await fetchQuotes(['AAPL'], fetchFn);
  assert.equal(out.AAPL.marketState, 'CLOSED');
});

test('fetchQuotes: missing numeric fields default to null', async () => {
  // Meta with all the numeric fields missing
  const { fetchFn } = makeFetchFn({
    WEIRD: mockResponse({
      chart: {
        result: [{
          meta: {
            currency: 'USD',
            symbol: 'WEIRD',
            instrumentType: 'EQUITY',
            // no regularMarketPrice, fiftyTwoWeekHigh, etc.
          },
        }],
        error: null,
      },
    }),
  });
  const out = await fetchQuotes(['WEIRD'], fetchFn);
  assert.equal(out.WEIRD.current_price, null);
  assert.equal(out.WEIRD.high_52w, null);
  assert.equal(out.WEIRD.low_52w, null);
  assert.equal(out.WEIRD.prev_close, null);
  assert.equal(out.WEIRD.currency, 'USD');
});

test('fetchQuotes: duplicate symbols are deduplicated', async () => {
  const { fetchFn, calls } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL')),
  });
  const out = await fetchQuotes(['AAPL', 'AAPL', 'AAPL'], fetchFn);
  assert.equal(calls.length, 1);
  assert.ok(out.AAPL);
});

test('fetchQuotes: uses proxy URL when PORTFOLIO_CONFIG.yahooProxyUrl is set', async () => {
  globalThis.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://my-proxy.example.workers.dev';
  try {
    const { fetchFn, calls } = makeFetchFn({
      AAPL: mockResponse(chartResponse('AAPL')),
    });
    const out = await fetchQuotes(['AAPL'], fetchFn);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith('https://my-proxy.example.workers.dev/?url='));
    assert.ok(calls[0].includes(encodeURIComponent('query1.finance.yahoo.com')));
    assert.equal(out.AAPL.current_price, 100);
  } finally {
    globalThis.PORTFOLIO_CONFIG.yahooProxyUrl = '';
  }
});

test('fetchQuotes: direct fetch (no proxy) when yahooProxyUrl is empty', async () => {
  globalThis.PORTFOLIO_CONFIG.yahooProxyUrl = '';
  const { fetchFn, calls } = makeFetchFn({
    AAPL: mockResponse(chartResponse('AAPL')),
  });
  await fetchQuotes(['AAPL'], fetchFn);
  assert.ok(calls[0].startsWith('https://query1.finance.yahoo.com/v8/finance/chart/AAPL'));
});

test('fetchQuotes: error classes are exported and instantiable', () => {
  assert.equal(typeof YahooAuthError, 'function');
  assert.equal(typeof YahooNetworkError, 'function');
  assert.equal(typeof YahooParseError, 'function');
  const e1 = new YahooAuthError('test');
  assert.equal(e1.name, 'YahooAuthError');
  assert.ok(e1 instanceof Error);
});