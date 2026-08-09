// lib/market-display.js — Day Δ% + 52W range bar display logic.
//
// Pure functions that compute the values shown in the new holdings table columns
// (Day Δ%, 52W range marker position). Source of truth for tests/market-display.test.js.
//
// Loaded by portfolio.html via <script src="lib/market-display.js"> (browser globals).
// Also imported by tests/market-display.test.js for Node.js testing (CommonJS).
//
// Architecture:
//   * Pure, no DOM. Browser + Node.js compatible.
//   * Returns strings (Tailwind class names, CSS style strings, formatted text)
//     so the Alpine component just binds the result.

(function (root) {
  'use strict';

  // ---- Day Δ% (spec §4.2) ----

  // Returns formatted label like "+1.23%", "-0.45%", "0.00%", or "—" when no data.
  // Sign explicit (positive gets "+", negative gets the "-" from toFixed).
  function dayDeltaLabel(h) {
    if (h.prev_close == null || h.prev_close === 0) return '—';
    const pct = ((h.current_price - h.prev_close) / h.prev_close) * 100;
    const sign = pct > 0 ? '+' : '';  // negative already has '-' from toFixed
    return `${sign}${pct.toFixed(2)}%`;
  }

  // Returns Tailwind class name: text-emerald-600 (positive), text-rose-600 (negative),
  // or text-slate-400 (neutral/null).
  function dayDeltaClass(h) {
    if (h.prev_close == null || h.prev_close === 0) return 'text-slate-400';
    const pct = ((h.current_price - h.prev_close) / h.prev_close) * 100;
    if (pct > 0) return 'text-emerald-600';
    if (pct < 0) return 'text-rose-600';
    return 'text-slate-400';
  }

  // ---- 52W range bar (spec §4.3) ----

  // Returns CSS style string like `left: 50.0%` for the marker dot.
  // Returns null when high_52w or low_52w is null (no bar shown).
  // Clamps position to [0%, 100%] in case current_price is outside [low, high].
  // When low === high (no range), marker centers at 50%.
  function week52Style(h) {
    if (h.high_52w == null || h.low_52w == null) return null;
    const range = h.high_52w - h.low_52w;
    const pct = range === 0
      ? 50
      : Math.max(0, Math.min(100, ((h.current_price - h.low_52w) / range) * 100));
    return `left: ${pct}%`;
  }

  const api = { dayDeltaLabel, dayDeltaClass, week52Style };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MarketDisplay = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);