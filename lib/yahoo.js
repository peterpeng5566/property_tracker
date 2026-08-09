// lib/yahoo.js — Yahoo Finance batch quote client (chart endpoint).
//
// Loaded by portfolio.html via <script src="lib/yahoo.js"> (browser globals).
// Also imported by tests/yahoo.test.js for Node.js testing (CommonJS).
//
// Source of truth: docs/v1.1-spec.md §2 + docs/research/05-chart-endpoint.md.
// ADR 0001 v1.1 documents the endpoint choice.
//
// Architecture:
//   * Pure functions, no DOM. Browser + Node.js compatible.
//   * fetchQuotes(symbols, fetchFn) — N parallel per-symbol fetches via the
//     /v8/finance/chart/<SYMBOL> endpoint. Symbol-level failure handling.
//   * CORS: requests go through a Cloudflare Worker (config.js →
//     window.PORTFOLIO_CONFIG.yahooProxyUrl). The Worker adds the CORS
//     header + UA + cookie. Direct Yahoo fetch from the browser is not
//     possible (Yahoo does not send CORS-permitting headers).
//   * Pure field mapping. No DOM, no state.
//
// Endpoint rationale (research/05-chart-endpoint.md):
//   As of 2025, Yahoo locked /v7/finance/quote behind crumb auth (which
//   requires browser session bootstrapping — can't replicate server-side).
//   The /v8/finance/chart/<SYMBOL> endpoint is the same data Yahoo uses
//   for its embed widgets and is publicly accessible with just cookie +
//   UA. Trade-off: no batch — we make N parallel requests, but for a
//   personal portfolio (10-30 holdings) this is fine.

(function (root) {
  'use strict';

  // ===== Errors =====
  class YahooAuthError extends Error {
    constructor(msg) { super(msg); this.name = 'YahooAuthError'; }
  }
  class YahooNetworkError extends Error {
    constructor(msg) { super(msg); this.name = 'YahooNetworkError'; }
  }
  class YahooParseError extends Error {
    constructor(msg) { super(msg); this.name = 'YahooParseError'; }
  }

  // ===== URL builder =====
  // Reads PORTFOLIO_CONFIG.yahooProxyUrl from global scope. If set, returns
  // `${proxy}/?url=${encodeURIComponent(fullUrl)}`. Else returns direct
  // Yahoo URL (browser will block with CORS — caller is expected to have
  // configured a proxy).
  const CHART_HOST = 'query1.finance.yahoo.com';

  function chartUrl(symbol) {
    return `https://${CHART_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  }

  function proxyUrl(yahooUrl) {
    const cfg = root.PORTFOLIO_CONFIG || {};
    const proxy = cfg.yahooProxyUrl;
    if (!proxy) return yahooUrl;
    return `${proxy}/?url=${encodeURIComponent(yahooUrl)}`;
  }

  // ===== Market state derivation =====
  // Chart endpoint doesn't return `marketState` directly. Derive it from
  // currentTradingPeriod + gmtoffset + current time. Output strings are the
  // same as Yahoo's quote endpoint: 'PRE', 'REGULAR', 'POST', 'CLOSED'.
  // FX/CURRENCY always returns 'CLOSED' (24/7 trading, but no intraday
  // warning applies per spec §6.4).
  function deriveMarketState(meta) {
    if (!meta) return 'CLOSED';
    if (meta.instrumentType === 'CURRENCY') return 'CLOSED';
    const ctp = meta.currentTradingPeriod;
    if (!ctp) return 'CLOSED';
    const offset = meta.gmtoffset || 0;
    const nowLocal = Math.floor(Date.now() / 1000) + offset;
    const regular = ctp.regular;
    const pre = ctp.pre;
    const post = ctp.post;
    if (regular && nowLocal >= regular.start && nowLocal < regular.end) return 'REGULAR';
    if (pre && nowLocal >= pre.start && nowLocal < pre.end) return 'PRE';
    if (post && nowLocal >= post.start && nowLocal < post.end) return 'POST';
    return 'CLOSED';
  }

  // ===== Field mapping =====
  // Chart endpoint returns `meta` object inside `chart.result[0]`. Extract
  // only the fields we use; don't propagate the rest.
  function mapQuote(meta) {
    return {
      current_price: typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null,
      high_52w: typeof meta.fiftyTwoWeekHigh === 'number' ? meta.fiftyTwoWeekHigh : null,
      low_52w: typeof meta.fiftyTwoWeekLow === 'number' ? meta.fiftyTwoWeekLow : null,
      prev_close: typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : null,
      marketState: deriveMarketState(meta),
      currency: typeof meta.currency === 'string' ? meta.currency : null,
      regularMarketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : null,
    };
  }

  // ===== Fetch one symbol =====
  // Returns { symbol, ok: true, data } on success, or { symbol, ok: false, failed: true } on failure.
  // Never throws — failures are per-symbol so the caller can show partial results.
  async function fetchOne(symbol, fetchFn) {
    const url = proxyUrl(chartUrl(symbol));
    let res;
    try {
      res = await fetchFn(url);
    } catch (e) {
      return { symbol, ok: false, failed: true };
    }
    if (!res || !res.ok) {
      // 404 → symbol not found. 5xx/429 → server/rate issue. Either way,
      // mark as failed; don't throw (other symbols may succeed).
      return { symbol, ok: false, failed: true };
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { symbol, ok: false, failed: true };
    }
    const result = json.chart && json.chart.result;
    if (!Array.isArray(result) || result.length === 0 || !result[0].meta) {
      return { symbol, ok: false, failed: true };
    }
    return { symbol, ok: true, data: mapQuote(result[0].meta) };
  }

  // ===== Public API =====
  // fetchQuotes(symbols, fetchFn)
  //   symbols: string[] — list of Yahoo tickers (e.g. ['AAPL', 'TWD=X'])
  //   fetchFn: function(url) => Promise<Response> — injected for testability
  //
  // Returns Promise<{ [symbol: string]: Quote | { failed: true } }>
  //   On total input error (no fetchFn, symbols not array): throws YahooAuthError.
  //   On per-symbol network/parse failure: marks that symbol as failed.
  async function fetchQuotes(symbols, fetchFn) {
    if (typeof fetchFn !== 'function') {
      throw new YahooAuthError('No fetch implementation provided');
    }
    if (!Array.isArray(symbols)) {
      throw new YahooAuthError('symbols must be an array');
    }
    if (symbols.length === 0) return {};

    // Dedup (preserve first-occurrence order for stable test output)
    const unique = [];
    const seen = new Set();
    for (const s of symbols) {
      if (!seen.has(s)) { seen.add(s); unique.push(s); }
    }

    const results = await Promise.all(unique.map(s => fetchOne(s, fetchFn)));
    const out = {};
    for (const r of results) {
      out[r.symbol] = r.ok ? r.data : { failed: true };
    }
    return out;
  }

  const api = {
    fetchQuotes,
    YahooAuthError,
    YahooNetworkError,
    YahooParseError,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Yahoo = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);