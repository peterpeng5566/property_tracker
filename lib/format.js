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

  const api = { formatAmount, toTWD, fromTWD };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html)
    root.formatAmount = formatAmount;
    root.toTWD = toTWD;
    root.fromTWD = fromTWD;
  }
})(typeof window !== 'undefined' ? window : globalThis);