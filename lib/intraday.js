// lib/intraday.js — Intraday market session detection.
//
// Pure functions that determine whether the user's portfolio is currently
// in an "intraday" state (i.e. at least one holding's market is actively trading).
// Source of truth for tests/intraday.test.js.
//
// Loaded by portfolio.html via <script src="lib/intraday.js"> (browser globals).
// Also imported by tests/intraday.test.js for Node.js testing (CommonJS).
//
// Background: spec.md §6.2, ADR 0009 §8, research/03-market-hours-detection.md.
//
// Yahoo's `marketState` enum values:
//   PREPRE, PRE, REGULAR, POST, POSTPOST — trading is happening (intraday)
//   CLOSED, OPENING_BELL, CLOSING_BELL, HALTED — not trading
//   (other values are unknown/region-specific; default to not-intraday)
//
// FX exception: holding's currency === 'FX' is excluded. FX (e.g. TWD=X) trades
// 24/7 with REGULAR always, but FX doesn't have a meaningful intraday concept
// for snapshot purposes.

(function (root) {
  'use strict';

  // The set of marketState values that mean "trading is happening".
  // See research/03-market-hours-detection.md for the rationale.
  const INTRADAY_STATES = new Set(['PREPRE', 'PRE', 'REGULAR', 'POST', 'POSTPOST']);

  // Returns true if any non-FX holding has a marketState in INTRADAY_STATES.
  // Defensive default: empty lastQuoteResults → false (no signal → no warning).
  //
  // Args:
  //   holdings: Array<{ ticker: string, currency?: string }>
  //   lastQuoteResults: { [ticker: string]: { marketState?: string } }
  //     Set by refreshAllPrices (ticket #10) from Yahoo Finance response.
  //
  // Returns boolean.
  function shouldWarnIntraday(holdings, lastQuoteResults) {
    if (!Array.isArray(holdings) || holdings.length === 0) return false;
    if (!lastQuoteResults || typeof lastQuoteResults !== 'object') return false;

    for (const h of holdings) {
      if (!h) continue;
      if (h.currency === 'FX') continue;  // FX exception (spec §6.4)
      const meta = lastQuoteResults[h.ticker];
      if (meta && INTRADAY_STATES.has(meta.marketState)) return true;
    }
    return false;
  }

  const api = { INTRADAY_STATES, shouldWarnIntraday };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Intraday = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);