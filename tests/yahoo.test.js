// tests/yahoo.test.js — automated tests for lib/yahoo.js
//
// Run with:
//   node --test tests/yahoo.test.js
// Or:
//   ./test.sh
//
// Spec source of truth: spec.md §9.1 (unit tests) + §9.2 (retry state machine).
// ADR 0001 v1.1 documents the endpoint + field names.
// Implementation is pure-function with DI (fetchFn), so we mock fetch without
// needing jsdom or network access.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Yahoo = require('../lib/yahoo.js');
const { fetchQuotes, bootstrapAuth, resetAuth, YahooAuthError, YahooNetworkError, YahooParseError } = Yahoo;

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

// For bootstrap: fc.yahoo.com returns 200 w/ cookie; /v1/test/getcrumb returns 200 w/ crumb text.
function bootstrapResponses(opts = {}) {
  const cookie = opts.cookie || 'PRF=abc123';
  const crumb = opts.crumb || 'crumble123';
  return [
    makeRes(200, '', { headers: { 'set-cookie': cookie } }),  // fc.yahoo.com
    makeRes(200, crumb, { headers: { 'content-type': 'text/plain' } }),  // getcrumb
  ];
}

// ===== Setup: reset module state before each test =====

test.beforeEach(() => {
  resetAuth();
});

// ===== Test 1: Single symbol, full response =====

test('fetchQuotes: single symbol, full response', async () => {
  const { fetchFn, calls } = makeMockFetch([
    ...bootstrapResponses(),
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

  // Verify bootstrap + quote was called
  assert.strictEqual(calls.length, 3);
  assert.match(calls[0].url, /^https:\/\/fc\.yahoo\.com/);
  assert.match(calls[1].url, /getcrumb/);
  assert.match(calls[2].url, /v7\/finance\/quote/);
  assert.match(calls[2].url, /symbols=AAPL/);
  assert.match(calls[2].url, /crumb=crumble123/);
});

// ===== Test 2: Multiple symbols, all succeed =====

test('fetchQuotes: multiple symbols, all succeed', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),
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
    ...bootstrapResponses(),
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

// ===== Test 4: 401 first, then 200 =====

test('fetchQuotes: 401 first, then 200 → re-bootstrap, retry succeeds', async () => {
  const { fetchFn, calls } = makeMockFetch([
    ...bootstrapResponses(),                                  // bootstrap #1 (2 calls)
    makeRes(401, { error: 'Unauthorized' }),                  // quote 401
    ...bootstrapResponses({ crumb: 'freshcrumb' }),           // bootstrap #2 (2 calls)
    makeRes(200, QUOTE_RESPONSE),                             // quote retry 200
  ]);

  const result = await fetchQuotes(['AAPL'], fetchFn);

  assert.strictEqual(result.AAPL.current_price, 175.5);
  // 2 (bootstrap) + 1 (quote 401) + 2 (re-bootstrap) + 1 (retry) = 6
  assert.strictEqual(calls.length, 6);
  // 6th call (retry) should use the new crumb
  assert.match(calls[5].url, /crumb=freshcrumb/);
});

// ===== Test 5: 401 twice → YahooAuthError =====

test('fetchQuotes: 401 twice → throws YahooAuthError', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),                                  // bootstrap #1
    makeRes(401, { error: 'Unauthorized' }),                  // quote 401
    ...bootstrapResponses(),                                  // re-bootstrap
    makeRes(401, { error: 'Unauthorized' }),                  // retry still 401
  ]);

  await assert.rejects(
    fetchQuotes(['AAPL'], fetchFn),
    (err) => err instanceof YahooAuthError && /401/.test(err.message)
  );
});

// ===== Test 6: 500 response → YahooNetworkError =====

test('fetchQuotes: 500 response → throws YahooNetworkError', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),
    makeRes(500, { error: 'Internal Server Error' }),
  ]);

  await assert.rejects(
    fetchQuotes(['AAPL'], fetchFn),
    (err) => err instanceof YahooNetworkError && /500/.test(err.message)
  );
});

// ===== Test 7: Malformed JSON → YahooParseError =====

test('fetchQuotes: malformed JSON → throws YahooParseError', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),
    makeRes(200, { broken: 'no quoteResponse here' }),
  ]);

  await assert.rejects(
    fetchQuotes(['AAPL'], fetchFn),
    (err) => err instanceof YahooParseError
  );
});

// ===== Test 8: Empty results array → all symbols failed =====

test('fetchQuotes: empty results array → all symbols failed: true', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),
    makeRes(200, { quoteResponse: { result: [], error: null } }),
  ]);

  const result = await fetchQuotes(['AAPL', 'GOOG', '2330.TW'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 3);
  assert.strictEqual(result.AAPL.failed, true);
  assert.strictEqual(result.GOOG.failed, true);
  assert.strictEqual(result['2330.TW'].failed, true);
});

// ===== Test 9: FX symbol parsed normally =====

test('fetchQuotes: FX symbol (TWD=X) parsed normally, currency: USD', async () => {
  const { fetchFn } = makeMockFetch([
    ...bootstrapResponses(),
    makeRes(200, QUOTE_RESPONSE_MULTI),
  ]);

  const result = await fetchQuotes(['TWD=X'], fetchFn);

  assert.strictEqual(result['TWD=X'].ticker, 'TWD=X');
  assert.strictEqual(result['TWD=X'].currency, 'USD');
  assert.strictEqual(result['TWD=X'].current_price, 0.0315);
  assert.strictEqual(result['TWD=X'].marketState, 'REGULAR');
});

// ===== Test 10: Field name mapping (exact) =====

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
    ...bootstrapResponses(),
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
    ...bootstrapResponses(),
    makeRes(200, QUOTE_RESPONSE),
  ]);

  const result = await fetchQuotes(['AAPL', 'AAPL', 'AAPL'], fetchFn);

  assert.strictEqual(Object.keys(result).length, 1);
  // URL should only have one AAPL
  assert.match(calls[2].url, /symbols=AAPL/);
  assert.doesNotMatch(calls[2].url, /symbols=AAPL,AAPL/);
});

// ===== Bonus: bootstrapAuth happy path =====

test('bootstrapAuth: returns cookie + crumb, caches in module', async () => {
  const { fetchFn, calls } = makeMockFetch(bootstrapResponses({ cookie: 'PRF=test', crumb: 'mycrumb' }));

  const result = await bootstrapAuth(fetchFn);

  assert.strictEqual(result.cookie, 'PRF=test');
  assert.strictEqual(result.crumb, 'mycrumb');
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/fc\.yahoo\.com/);
  assert.match(calls[1].url, /getcrumb/);
});

// ===== Bonus: bootstrapAuth fails if cookie fetch fails =====

test('bootstrapAuth: throws YahooAuthError if cookie fetch fails', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(503, { error: 'Service Unavailable' }),
  ]);

  await assert.rejects(
    bootstrapAuth(fetchFn),
    (err) => err instanceof YahooAuthError && /503/.test(err.message)
  );
});

// ===== Bonus: bootstrapAuth fails if crumb is empty =====

test('bootstrapAuth: throws YahooAuthError if crumb is empty', async () => {
  const { fetchFn } = makeMockFetch([
    makeRes(200, '', { headers: { 'set-cookie': 'PRF=abc' } }),
    makeRes(200, '   ', { headers: { 'content-type': 'text/plain' } }),  // whitespace = empty after trim
  ]);

  await assert.rejects(
    bootstrapAuth(fetchFn),
    (err) => err instanceof YahooAuthError && /empty crumb/.test(err.message)
  );
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

// ===== Retry state machine tests (spec §9.2) =====

// Note: spec §9.2 describes `refreshAllPrices` retry logic, which is in
// portfolio.html (ticket #10). Lower-level auth retry is in fetchQuotes.
// These tests cover the lower-level auth retry that's already in lib/yahoo.js.

// Retry behavior: re-bootstrap on 401 (verified in Test 4)
// Retry behavior: throw YahooAuthError after 2 failures (verified in Test 5)
// Retry behavior: keep crumb cached across successful calls (verified in Test 1)

test('fetchQuotes: crumb is cached across calls (no re-bootstrap)', async () => {
  const { fetchFn, calls } = makeMockFetch([
    ...bootstrapResponses({ crumb: 'cacheme' }),  // bootstrap once
    makeRes(200, QUOTE_RESPONSE),                 // call 1
    makeRes(200, QUOTE_RESPONSE),                 // call 2 — should NOT re-bootstrap
  ]);

  await fetchQuotes(['AAPL'], fetchFn);
  await fetchQuotes(['AAPL'], fetchFn);

  // 2 quote calls + 2 bootstrap calls = 4 total
  assert.strictEqual(calls.length, 4);
  assert.match(calls[2].url, /crumb=cacheme/);
  assert.match(calls[3].url, /crumb=cacheme/);
});
