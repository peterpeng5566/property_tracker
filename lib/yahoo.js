// lib/yahoo.js — Yahoo Finance batch quote client.
//
// Loaded by portfolio.html via <script src="lib/yahoo.js"> (browser globals).
// Also imported by tests/yahoo.test.js for Node.js testing (CommonJS).
//
// Source of truth: spec.md §2 + research/02-yahoo-batch-endpoint.md.
// ADR 0001 v1.1 documents the endpoint choice + crumb auth.
//
// Architecture:
//   * Pure functions, no DOM. Browser + Node.js compatible.
//   * fetchQuotes(symbols, fetchFn) — batch fetch with symbol-level failure handling.
//   * bootstrapAuth(fetchFn) — fetches cookie + crumb, caches in module scope.
//   * Cookie + crumb cached in closure. Re-bootstrap only on 401.
//   * Browser: credentials: 'include' lets the browser's cookie jar handle cookies.
//   * Test mock: pass canned responses via fetchFn.
//
// CORS: Yahoo's query1.finance.yahoo.com does not send CORS-permitting headers for
// arbitrary origins. Browser-side resolution is ticket #13; this library is
// fetch-proxy-agnostic.

(function (root) {
  'use strict';

  // ===== Custom errors =====
  class YahooAuthError extends Error {
    constructor(message) {
      super(message);
      this.name = 'YahooAuthError';
    }
  }

  class YahooNetworkError extends Error {
    constructor(message) {
      super(message);
      this.name = 'YahooNetworkError';
    }
  }

  class YahooParseError extends Error {
    constructor(message) {
      super(message);
      this.name = 'YahooParseError';
    }
  }

  // ===== Endpoints =====
  const FC_URL = 'https://fc.yahoo.com';
  const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
  const QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';

  // ===== Module-internal cached state (closure) =====
  let _cookie = null;
  let _crumb = null;

  // ===== Helpers =====
  function extractSetCookie(headers) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      // Headers object (or duck-typed)
      return headers.get('set-cookie');
    }
    if (Array.isArray(headers)) {
      // Array of [name, value] pairs
      const found = headers.find(([k]) => String(k).toLowerCase() === 'set-cookie');
      return found ? found[1] : null;
    }
    if (typeof headers === 'object') {
      // Plain object
      const key = Object.keys(headers).find(k => k.toLowerCase() === 'set-cookie');
      return key ? headers[key] : null;
    }
    return null;
  }

  function resetAuth() {
    _cookie = null;
    _crumb = null;
  }

  // ===== Auth bootstrap =====
  async function bootstrapAuth(fetchFn) {
    if (fetchFn === undefined) fetchFn = root.fetch;
    if (typeof fetchFn !== 'function') {
      throw new YahooAuthError('No fetch implementation provided');
    }

    // Step 1: GET fc.yahoo.com to set the consent cookie.
    const cookieRes = await fetchFn(FC_URL, { credentials: 'include', redirect: 'follow' });
    if (!cookieRes.ok) {
      throw new YahooAuthError(`Failed to fetch Yahoo consent cookie: HTTP ${cookieRes.status}`);
    }
    // Extract Set-Cookie from response.headers if exposed (Node.js / test mock).
    // Browser hides Set-Cookie from JS; the browser's cookie jar handles it.
    const setCookie = extractSetCookie(cookieRes.headers);
    if (setCookie) {
      // Use the first cookie value (before any '; ' attrs). Yahoo sets: PRF=...; ...
      _cookie = setCookie.split(';')[0];
    }

    // Step 2: GET crumb using the cookie.
    const crumbOpts = { credentials: 'include' };
    if (_cookie) crumbOpts.headers = { Cookie: _cookie };

    const crumbRes = await fetchFn(CRUMB_URL, crumbOpts);
    if (!crumbRes.ok) {
      throw new YahooAuthError(`Failed to fetch Yahoo crumb: HTTP ${crumbRes.status}`);
    }
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) {
      throw new YahooAuthError('Yahoo returned empty crumb');
    }
    _crumb = crumb;
    return { cookie: _cookie, crumb: _crumb };
  }

  // ===== Fetch quotes =====
  async function fetchQuotes(symbols, fetchFn) {
    if (fetchFn === undefined) fetchFn = root.fetch;
    if (typeof fetchFn !== 'function') {
      throw new YahooAuthError('No fetch implementation provided');
    }
    if (!Array.isArray(symbols)) {
      throw new YahooAuthError('symbols must be an array');
    }
    if (symbols.length === 0) return {};

    // Dedupe input symbols (canonical Yahoo behavior)
    const uniqueSymbols = [...new Set(symbols)];

    // Bootstrap if not yet cached
    if (!_crumb) {
      await bootstrapAuth(fetchFn);
    }

    // Build request options
    const opts = { credentials: 'include' };
    if (_cookie) opts.headers = { Cookie: _cookie };

    // Build URL
    const symbolsParam = uniqueSymbols.join(',');
    const url = `${QUOTE_URL}?symbols=${encodeURIComponent(symbolsParam)}&crumb=${encodeURIComponent(_crumb)}`;

    let res = await fetchFn(url, opts);

    // 401 retry: re-bootstrap once, retry once
    if (res.status === 401) {
      resetAuth();
      await bootstrapAuth(fetchFn);
      const retryOpts = { credentials: 'include' };
      if (_cookie) retryOpts.headers = { Cookie: _cookie };
      const retryUrl = `${QUOTE_URL}?symbols=${encodeURIComponent(symbolsParam)}&crumb=${encodeURIComponent(_crumb)}`;
      res = await fetchFn(retryUrl, retryOpts);
      if (res.status === 401) {
        throw new YahooAuthError('Yahoo returned 401 after re-bootstrap');
      }
    }

    if (!res.ok) {
      throw new YahooNetworkError(`Yahoo returned HTTP ${res.status}`);
    }

    // Parse JSON
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new YahooParseError(`Failed to parse Yahoo JSON: ${e.message}`);
    }

    if (!json || typeof json !== 'object' || !json.quoteResponse || !Array.isArray(json.quoteResponse.result)) {
      throw new YahooParseError('Yahoo response missing quoteResponse.result');
    }

    // Map results by symbol
    const result = {};
    const foundSymbols = new Set();
    for (const q of json.quoteResponse.result) {
      if (!q || !q.symbol) continue;
      result[q.symbol] = {
        ticker: q.symbol,
        currency: q.currency,
        current_price: q.regularMarketPrice,
        high_52w: q.fiftyTwoWeekHigh,
        low_52w: q.fiftyTwoWeekLow,
        prev_close: q.regularMarketPreviousClose,
        marketState: q.marketState,
      };
      foundSymbols.add(q.symbol);
    }

    // Mark missing symbols as failed (silent-drop behavior)
    for (const symbol of uniqueSymbols) {
      if (!foundSymbols.has(symbol)) {
        result[symbol] = { ticker: symbol, failed: true };
      }
    }

    return result;
  }

  const api = {
    fetchQuotes,
    bootstrapAuth,
    resetAuth,
    YahooAuthError,
    YahooNetworkError,
    YahooParseError,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html)
    root.Yahoo = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
