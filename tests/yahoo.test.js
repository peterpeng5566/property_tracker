// tests/yahoo.test.js — automated tests for lib/yahoo.js
//
// Run with:
//   node --test tests/yahoo.test.js
// Or:
//   ./test.sh
//
// Spec source of truth: spec.md §9.1 (unit tests).
// ADR 0001 v1.1 documents the endpoint + field names.
//
// Implementation is pure-function with DI (fetchFn), so we mock fetch without
// needing jsdom or network access. As of v1.1 the lib routes through a proxy
// URL (window.PORTFOLIO_CONFIG.yahooProxyUrl) when set; tests cover both modes.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Yahoo = require('../lib/yahoo.js');
const { fetchQuotes, YahooAuthError, YahooNetworkError, YahooParseError } = Yahoo;

// ===== Mock helpers =====

// Build a fetch response with sensible defaults.
// `body` may be a JS object (will be JSON.stringified) or a string.
function makeRes(status, body, opts = {}) {
  const headers = opts.headers || {};
  const isString = typeof body === 'string';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      // Headers-like duck-typed access
      get: (name) => {
        const k = name.toLowerCase();
        return headers[k] !== undefined ? headers[k] : null;
      },
    },
    json: async () => {
      if (isString) return JSON.parse(body);
      return body;
    },
    text: async () => isString ? body : JSON.stringify(body),
  };
}

// Build a mock fetch that returns canned responses in sequence.
// Records all calls so tests can inspect them.
function makeMockFetch(responses) {
  let i = 0;
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts: opts || {} });
    if (i >= responses.length) {
      throw new Error(`Mock fetch: no more canned responses (call #${i + 1} to ${url})`);
    }
    return responses[i++];
  };
  return { fetchFn, calls };
}

// ===== Common Yahoo response fixtures =====

const QUOTE_RESPONSE = {
  quoteResponse: {
    result: [
      {
        symbol: 'AAPL',
        currency: 'USD',
        regularMarketPrice: 175.5,
        fiftyTwoWeekHigh: 200.0,
        fiftyTwoWeekLow: 150.0,
        regularMarketPreviousClose: 170.0,
        marketState: 'REGULAR',
      },
    ],
    error: null,
  },
};

const QUOTE_RESPONSE_MULTI = {
  quoteResponse: {
    result: [
      { symbol: 'AAPL', currency: 'USD', regularMarketPrice: 175.5, fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 150, regularMarketPreviousClose: 170, marketState: 'REGULAR' },
      { symbol: '2330.TW', currency: 'TWD', regularMarketPrice: 600, fiftyTwoWeekHigh: 700, fiftyTwoWeekLow: 500, regularMarketPreviousClose: 590, marketState: 'CLOSED' },
      { symbol: 'GOOG', currency: 'USD', regularMarketPrice: 130.2, fiftyTwoWeekHigh: 145, fiftyTwoWeekLow: 110, regularMarketPreviousClose: 128, marketState: 'REGULAR' },
      { symbol: 'MSFT', currency: 'USD', regularMarketPrice: 410.0, fiftyTwoWeekHigh: 430, fiftyTwoWeekLow: 380, regularMarketPreviousClose: 405, marketState: 'REGULAR' },
      { symbol: 'TWD=X', currency: 'USD', regularMarketPrice: 0.0315, fiftyTwoWeekHigh: 0.033, fiftyTwoWeekLow: 0.030, regularMarketPreviousClose: 0.0312, marketState: 'REGULAR', quoteType: 'CURRENCY' },
    ],
    error: null,
  },
};

// ===== Setup: clear config between tests =====
// In Node, the lib captures `globalThis` as `root` (since `typeof window` is
// undefined). Tests set `globalThis.PORTFOLIO_CONFIG` (a.k.a. `global.X`)
// which is what the lib reads.

const savedConfig = globalThis.PORTFOLIO_CONFIG;

test.beforeEach(() => {
  // Default: no proxy (direct fetch). Tests that want proxy set it explicitly.
  delete globalThis.PORTFOLIO_CONFIG;
});

test.after(() => {
  // Restore whatever was there before tests ran.
  if (savedConfig !== undefined) {
    globalThis.PORTFOLIO_CONFIG = savedConfig;
  } else {
    delete globalThis.PORTFOLIO_CONFIG;
  }
});

// ===== Test 1: Single symbol, full response =====

test('fetchQuotes: single symbol, full response', async () => {
  const { fetchFn, calls } = makeMockFetch([
    makeRes(200, QUOTE_RESPONSE),
  ]);

  const result = await fetchQuotes(['AAPL'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 1);
  assert.deepStrictEqual(result.AAPL, {
    ticker: 'AAPL',
    currency: 'USD',
    current_price: 175.5,
    high_52w: 200.0,
    low_52w: 150.0,
    prev_close: 170.0,
    marketState: 'REGULAR',
  });

  // Direct fetch (no proxy configured)
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL');
});

// ===== Test 2: Multiple symbols, all succeed =====

test('fetchQuotes: multiple symbols, all succeed', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(200, QUOTE_RESPONSE_MULTI),
  ]);

  const result = await fetchQuotes(['AAPL', '2330.TW', 'GOOG', 'MSFT', 'TWD=X'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 5);
  assert.strictEqual(result.AAPL.current_price, 175.5);
  assert.strictEqual(result['2330.TW'].currency, 'TWD');
  assert.strictEqual(result['2330.TW'].marketState, 'CLOSED');
  assert.strictEqual(result['TWD=X'].currency, 'USD');
  assert.strictEqual(result['TWD=X'].quoteType, undefined);  // not propagated
});

// ===== Test 3: Multiple symbols, one missing =====

test('fetchQuotes: multiple symbols, one missing → failed: true', async () => {
  // Request 5 symbols, response has 4 (TYPO is silently dropped)
  const { fetchFn } = makeMockFetch([
    makeRes(200, QUOTE_RESPONSE_MULTI),
  ]);

  const result = await fetchQuotes(['AAPL', '2330.TW', 'GOOG', 'MSFT', 'TWD=X', 'TYPO_XX'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 6);
  assert.strictEqual(result.AAPL.current_price, 175.5);
  assert.strictEqual(result.TYPO_XX.failed, true);
  assert.strictEqual(result.TYPO_XX.ticker, 'TYPO_XX');
  // Make sure other fields are absent
  assert.strictEqual(result.TYPO_XX.current_price, undefined);
});

// ===== Test 4: 500 response → YahooNetworkError =====

test('fetchQuotes: 500 response → throws YahooNetworkError', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(500, { error: 'Internal Server Error' }),
  ]);

  await assert.rejects(
    fetchQuotes(['AAPL'], fetchFn),
    (err) => err instanceof YahooNetworkError && /500/.test(err.message)
  );
});

// ===== Test 5: Malformed JSON → YahooParseError =====

test('fetchQuotes: malformed JSON → throws YahooParseError', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(200, { broken: 'no quoteResponse here' }),
  ]);

  await assert.rejects(
    fetchQuotes(['AAPL'], fetchFn),
    (err) => err instanceof YahooParseError
  );
});

// ===== Test 6: Empty results array → all symbols failed =====

test('fetchQuotes: empty results array → all symbols failed: true', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(200, { quoteResponse: { result: [], error: null } }),
  ]);

  const result = await fetchQuotes(['AAPL', 'GOOG', '2330.TW'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 3);
  assert.strictEqual(result.AAPL.failed, true);
  assert.strictEqual(result.GOOG.failed, true);
  assert.strictEqual(result['2330.TW'].failed, true);
});

// ===== Test 7: FX symbol parsed normally =====

test('fetchQuotes: FX symbol (TWD=X) parsed normally, currency: USD', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(200, QUOTE_RESPONSE_MULTI),
  ]);

  const result = await fetchQuotes(['TWD=X'], fetchFn);

  assert.strictEqual(result['TWD=X'].ticker, 'TWD=X');
  assert.strictEqual(result['TWD=X'].currency, 'USD');
  assert.strictEqual(result['TWD=X'].current_price, 0.0315);
  assert.strictEqual(result['TWD=X'].marketState, 'REGULAR');
});

// ===== Test 8: Field name mapping (exact) =====

test('fetchQuotes: Yahoo field names map correctly', async () => {
  // Verify exact field names: regularMarketPrice → current_price, etc.
  const customQuote = {
    quoteResponse: {
      result: [{
        symbol: 'TEST',
        currency: 'USD',
        regularMarketPrice: 100.0,           // → current_price
        fiftyTwoWeekHigh: 200.0,             // → high_52w
        fiftyTwoWeekLow: 50.0,               // → low_52w
        regularMarketPreviousClose: 95.0,    // → prev_close
        marketState: 'CLOSED',               // → marketState
        // Other fields Yahoo might return that we should NOT propagate
        regularMarketDayHigh: 105,
        regularMarketDayLow: 95,
        regularMarketVolume: 1000000,
        shortName: 'Test Co',
        quoteType: 'EQUITY',
      }],
      error: null,
    },
  };

  const { fetchFn } = makeMockFetch([
    makeRes(200, customQuote),
  ]);

  const result = await fetchQuotes(['TEST'], fetchFn);

  // Verify all expected fields mapped
  assert.strictEqual(result.TEST.current_price, 100.0);
  assert.strictEqual(result.TEST.high_52w, 200.0);
  assert.strictEqual(result.TEST.low_52w, 50.0);
  assert.strictEqual(result.TEST.prev_close, 95.0);
  assert.strictEqual(result.TEST.marketState, 'CLOSED');
  // Verify unwanted fields are NOT propagated
  assert.strictEqual(result.TEST.regularMarketDayHigh, undefined);
  assert.strictEqual(result.TEST.regularMarketVolume, undefined);
  assert.strictEqual(result.TEST.shortName, undefined);
  assert.strictEqual(result.TEST.quoteType, undefined);
});

// ===== Bonus: empty symbols array returns empty object =====

test('fetchQuotes: empty symbols array returns empty object (no fetch)', async () => {
  const { fetchFn, calls } = makeMockFetch([]);

  const result = await fetchQuotes([], fetchFn);

  assert.deepStrictEqual(result, {});
  assert.strictEqual(calls.length, 0);  // no fetch calls
});

// ===== Bonus: duplicates are deduped =====

test('fetchQuotes: duplicate symbols are deduped', async () => {
  const { fetchFn, calls } = makeMockFetch([
    makeRes(200, QUOTE_RESPONSE),
  ]);

  const result = await fetchQuotes(['AAPL', 'AAPL', 'AAPL'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 1);
  // URL should only have one AAPL
  assert.match(calls[0].url, /symbols=AAPL/);
  assert.doesNotMatch(calls[0].url, /symbols=AAPL,AAPL/);
});

// ===== Bonus: Error classes are exported correctly =====

test('Yahoo: error classes are exported with correct names', () => {
  const errA = new YahooAuthError('test');
  const errN = new YahooNetworkError('test');
  const errP = new YahooParseError('test');
  assert.strictEqual(errA.name, 'YahooAuthError');
  assert.strictEqual(errN.name, 'YahooNetworkError');
  assert.strictEqual(errP.name, 'YahooParseError');
  assert.ok(errA instanceof Error);
  assert.ok(errN instanceof Error);
  assert.ok(errP instanceof Error);
});

// ===== Proxy routing =====

test('fetchQuotes: uses proxy URL when PORTFOLIO_CONFIG.yahooProxyUrl is set', async () => {
  globalThis.PORTFOLIO_CONFIG = { yahooProxyUrl: 'https://my-proxy.workers.dev' };

  let capturedUrl = '';
  const fetchFn = async (url) => {
    capturedUrl = url;
    return makeRes(200, QUOTE_RESPONSE);
  };

  await fetchQuotes(['AAPL'], fetchFn);

  // Should be routed through the proxy with Yahoo URL as ?url= param
  assert.match(capturedUrl, /^https:\/\/my-proxy\.workers\.dev\/\?url=/);
  assert.ok(capturedUrl.includes(encodeURIComponent('https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL')));
});

test('fetchQuotes: direct fetch when no proxy configured (default)', async () => {
  // No PORTFOLIO_CONFIG set
  let capturedUrl = '';
  const fetchFn = async (url) => {
    capturedUrl = url;
    return makeRes(200, QUOTE_RESPONSE);
  };

  await fetchQuotes(['AAPL'], fetchFn);

  assert.strictEqual(capturedUrl, 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL');
});

test('fetchQuotes: empty proxy URL falls back to direct fetch', async () => {
  globalThis.PORTFOLIO_CONFIG = { yahooProxyUrl: '' };

  let capturedUrl = '';
  const fetchFn = async (url) => {
    capturedUrl = url;
    return makeRes(200, QUOTE_RESPONSE);
  };

  await fetchQuotes(['AAPL'], fetchFn);

  assert.strictEqual(capturedUrl, 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL');
});
