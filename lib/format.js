// lib/format.js — pure monetary formatting helpers.
//
// Loaded by portfolio.html via <script src="lib/format.js"> (browser globals).
// Also imported by tests/format.test.js for Node.js testing (CommonJS).
//
// Source of truth for the compact suffix display rules:
//   TWD: ≥100M → Y (億), ≥10K → W (萬), else full ($1,265.86)
//   USD: ≥1M  → M, ≥1K → K, else full ($1,265.86)
// All values use '$' prefix regardless of currency; 2 decimals; '-' for negatives.
// Thresholds are >= (inclusive). Spec: issue #10, CONTEXT.md "Compact suffix".

(function (root) {
  'use strict';

  function toTWD(amount, currency, fxRate) {
    if (currency === 'TWD') return amount;
    if (currency === 'USD') return amount * fxRate;
    return amount;
  }

  function fromTWD(amount, currency, fxRate) {
    if (currency === 'TWD') return amount;
    if (currency === 'USD') return amount / fxRate;
    return amount;
  }

  // Raw-number currency conversion. Returns a number (not a string).
  // Use the same fxRate for both directions — typically the *snapshot's*
  // frozen fx_rate, NOT the current one, so historical values stay
  // anchored to when they were captured.
  function convertCurrency(amount, sourceCurrency, targetCurrency, fxRate) {
    if (sourceCurrency === targetCurrency) return amount;
    return fromTWD(toTWD(amount, sourceCurrency, fxRate), targetCurrency, fxRate);
  }

  function formatAmount(amount, sourceCurrency, displayCurrency, fxRate) {
    const converted = fromTWD(toTWD(amount, sourceCurrency, fxRate), displayCurrency, fxRate);
    const sign = converted < 0 ? '-' : '';
    const abs = Math.abs(converted);
    let value, suffix;
    if (displayCurrency === 'USD') {
      if (abs >= 1_000_000) { suffix = 'M'; value = abs / 1_000_000; }
      else if (abs >= 1_000) { suffix = 'K'; value = abs / 1_000; }
      else { suffix = ''; value = abs; }
    } else { // TWD
      if (abs >= 100_000_000) { suffix = 'Y'; value = abs / 100_000_000; }
      else if (abs >= 10_000) { suffix = 'W'; value = abs / 10_000; }
      else { suffix = ''; value = abs; }
    }
    const formatted = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sign + '$' + formatted + suffix;
  }

  // deltaPercent: pure helper for the snapshot compare view
  // (v1.5 — .scratch/v1.5-snapshot-ui/issues/04-compare-two-snapshots.md).
  // Returns a "+X.X%" / "-X.X%" / "+0.0%" string, or "—" when the
  // denominator is zero or either value is non-finite. Honest signal:
  // a division by zero would be infinite, which has no meaning in
  // "how much did my net worth change in % terms".
  function deltaPercent(num, denom) {
    if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return '—';
    const pct = (num / denom) * 100;
    const sign = pct < 0 ? '-' : '+';
    return `${sign}${Math.abs(pct).toFixed(1)}%`;
  }

  const api = { formatAmount, toTWD, fromTWD, convertCurrency, deltaPercent };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html)
    root.formatAmount = formatAmount;
    root.toTWD = toTWD;
    root.fromTWD = fromTWD;
    root.convertCurrency = convertCurrency;
    root.deltaPercent = deltaPercent;
    // Namespace (mirrors root.Calc / root.Serialize pattern) so other
    // lib modules that capture `root.Format` at IIFE-evaluation time can
    // resolve the same api.
    root.Format = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);