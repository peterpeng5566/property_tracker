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

  // ---- v1.20 T02 (ADR 0026): Rebalance Action cell text + colour ----
  //
  // Pure formatter for the candidate-row Action cell. Returns the
  // locale-neutral signed number (units suffix for holdings, dollar for
  // cash) and the Tailwind class for the cell colour. Driven by a
  // single per-candidate numeric field (`deltaShares` for holdings,
  // `deltaAmount` for cash).
  //
  // Holdings: `+N.NNS` (USD / non-TWD shares) or `+N.NNL` (TWD lots;
  // 1 lot = 1000 shares). Cash: `+$AMOUNT` via formatAmountNative so
  // the K/M/W/Y compact suffix matches the Δ column. Sign character
  // is `+` for buy/add and U+2212 (`−`) for sell/reduce; zero always
  // renders with `+` and slate-400.

  // Extract the signed numeric delta the candidate row's Action cell
  // should be built from. Returns {value, isZero}. Negative vs positive
  // is preserved (zero collapses to the slate-400 path).
  function _rebalanceDelta(candidate) {
    const delta = candidate.delta || {};
    const v = candidate.kind === 'holding' ? delta.deltaShares : delta.deltaAmount;
    if (typeof v !== 'number' || !Number.isFinite(v)) return { value: 0, isZero: true };
    return { value: v, isZero: v === 0 };
  }

  function formatRebalanceActionText(candidate) {
    const d = _rebalanceDelta(candidate);
    const isLots = candidate.kind === 'holding' && candidate.currency === 'TWD';
    if (candidate.kind === 'holding') {
      const raw = Math.abs(d.value);
      const displayNum = (isLots ? raw / 1000 : raw)
        .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const unit = isLots ? 'L' : 'S';
      return (d.value >= 0 ? '+' : '\u2212') + displayNum + unit;
    }
    // Cash: formatAmountNative renders compact suffix for large amounts
    // (K/M for USD, W/Y for TWD) to match the Δ column.
    const amountStr = formatAmount(Math.abs(d.value), candidate.currency, candidate.currency, 1);
    return (d.value >= 0 ? '+' : '\u2212') + amountStr;
  }

  function formatRebalanceActionClass(candidate) {
    const d = _rebalanceDelta(candidate);
    if (d.isZero) return 'text-slate-400';
    return d.value >= 0 ? 'text-emerald-600' : 'text-rose-600';
  }

  const api = {
    formatAmount, toTWD, fromTWD, convertCurrency, deltaPercent,
    formatRebalanceActionText, formatRebalanceActionClass,
  };

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
    root.formatRebalanceActionText = formatRebalanceActionText;
    root.formatRebalanceActionClass = formatRebalanceActionClass;
    // Namespace (mirrors root.Calc / root.Serialize pattern) so other
    // lib modules that capture `root.Format` at IIFE-evaluation time can
    // resolve the same api.
    root.Format = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);