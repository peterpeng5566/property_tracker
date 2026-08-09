// lib/yahoo.js — Yahoo Finance batch quote client.
//
// Loaded by portfolio.html via <script src="lib/yahoo.js"> (browser globals).
// Also imported by tests/yahoo.test.js for Node.js testing (CommonJS).
//
// Source of truth: spec.md §2 + research/02-yahoo-batch-endpoint.md.
// ADR 0001 v1.1 documents the endpoint choice.
//
// Architecture:
//   * Pure functions, no DOM. Browser + Node.js compatible.
//   * fetchQuotes(symbols, fetchFn) — batch fetch with symbol-level failure handling.
//   * CORS: requests go through a Cloudflare Worker (config.js →
//     window.PORTFOLIO_CONFIG.yahooProxyUrl). The Worker handles Yahoo
//     cookie/crumb auth server-side. Direct Yahoo fetch from the browser is
//     not possible (Yahoo does not send CORS-permitting headers).
//   * If yahooProxyUrl is empty (default for tests), requests go direct.
//   * Test mock: pass canned responses via fetchFn (DI pattern).

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

  // ===== Proxy helper =====
  // Builds the request URL. When PORTFOLIO_CONFIG.yahooProxyUrl is set,
  // routes through the Cloudflare Worker. Otherwise, hits Yahoo directly
  // (useful for tests or if the Worker is down).
  function proxyUrl(yahooPath) {
    const cfg = root.PORTFOLIO_CONFIG || {};
    const proxy = cfg.yahooProxyUrl;
    const fullUrl = `https://query1.finance.yahoo.com${yahooPath}`;
    if (!proxy) return fullUrl;
    return `${proxy}/?url=${encodeURIComponent(fullUrl)}`;
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

    // Build URL (direct or via proxy)
    const symbolsParam = uniqueSymbols.join(',');
    const url = proxyUrl(`/v7/finance/quote?symbols=${encodeURIComponent(symbolsParam)}`);

    const res = await fetchFn(url);

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
