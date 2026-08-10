// lib/calc.js — pure Home-page calculation helpers (v1.2).
//
// Loaded by portfolio.html via <script src="lib/calc.js"> (browser globals).
// Also imported by tests/calc.test.js for Node.js testing (CommonJS).
//
// Source of truth for the math that backs the Home page summary cards and
// the Holdings table gain/loss column. FX conversion is delegated to
// lib/format.js toTWD/fromTWD so the conversion rules live in one place.
//
// Multi-arg functions take (items, displayCurrency, fxRate) explicitly so
// they can be exercised under node:test without any Alpine state. Per-holding
// gainLoss(h) is the single-arg exception — it operates on the holding's
// native currency and never FX-converts.
//
// The corresponding Alpine methods (holdingsValue / holdingsCost /
// holdingsGainLoss / holdingsGainLossPct / totalCash / totalDebts /
// netWorth / gainLoss / activeHoldingsCount / activeCashCount /
// activeDebtsCount / toTWD / fromTWD / _holdingsValueTWD /
// _holdingsCostTWD / _totalCashTWD / _totalDebtsTWD) become thin shims
// that call into this module. Spec: .scratch/v1.2-testing-safety-net/
// issues/04-lib-calc-extraction.md.

(function (root) {
  'use strict';

  // Pull FX conversion rules from lib/format.js so the conversion logic is
  // defined exactly once in this codebase. In Node, require() the module;
  // in the browser, format.js has already exposed toTWD/fromTWD on the
  // global root via its own IIFE, so destructure from there instead.
  const Format = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./format.js')
    : { toTWD: root.toTWD, fromTWD: root.fromTWD };
  const { toTWD, fromTWD } = Format;

  // Generic active filter — `inactive` is truthy when the user has toggled
  // the record off; records fresh out of the editor before the toggle is
  // set still count as active.
  function isActive(r) { return !r.inactive; }

  // Sum a per-record value across an active slice, summing in TWD so the
  // result is independent of displayCurrency, then converting once at the
  // end. The `fn(record)` argument extracts the per-record TWD amount.
  function sumInTWD(records, fn, displayCurrency, fxRate) {
    const twd = records.filter(isActive).reduce((sum, r) => sum + fn(r), 0);
    return fromTWD(twd, displayCurrency, fxRate);
  }

  function holdingsValue(holdings, displayCurrency, fxRate) {
    return sumInTWD(
      holdings,
      (h) => toTWD(h.shares * h.current_price, h.currency, fxRate),
      displayCurrency,
      fxRate
    );
  }

  function holdingsCost(holdings, displayCurrency, fxRate) {
    return sumInTWD(
      holdings,
      (h) => toTWD(h.shares * h.cost, h.currency, fxRate),
      displayCurrency,
      fxRate
    );
  }

  function holdingsGainLoss(holdings, displayCurrency, fxRate) {
    return holdingsValue(holdings, displayCurrency, fxRate)
         - holdingsCost(holdings, displayCurrency, fxRate);
  }

  function holdingsGainLossPct(holdings, displayCurrency, fxRate) {
    const cost = holdingsCost(holdings, displayCurrency, fxRate);
    if (cost === 0) return 0;
    return (holdingsGainLoss(holdings, displayCurrency, fxRate) / cost) * 100;
  }

  function totalCash(cashAccounts, displayCurrency, fxRate) {
    return sumInTWD(
      cashAccounts,
      (c) => toTWD(c.balance, c.currency, fxRate),
      displayCurrency,
      fxRate
    );
  }

  function totalDebts(debts, displayCurrency, fxRate) {
    return sumInTWD(
      debts,
      (d) => toTWD(d.balance, d.currency, fxRate),
      displayCurrency,
      fxRate
    );
  }

  function netWorth(holdings, cashAccounts, debts, displayCurrency, fxRate) {
    return holdingsValue(holdings, displayCurrency, fxRate)
         + totalCash(cashAccounts, displayCurrency, fxRate)
         - totalDebts(debts, displayCurrency, fxRate);
  }

  // Per-holding gain/loss in the holding's native currency. No FX — the
  // Holdings table displays gain/loss in the holding's own currency.
  function gainLoss(h) {
    return h.shares * (h.current_price - h.cost);
  }

  // Generic active counter shared by activeHoldingsCount / activeCashCount /
  // activeDebtsCount in the Alpine layer.
  function activeCount(records) {
    return records.filter(isActive).length;
  }

  const api = {
    holdingsValue,
    holdingsCost,
    holdingsGainLoss,
    holdingsGainLossPct,
    totalCash,
    totalDebts,
    netWorth,
    gainLoss,
    activeCount,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html). portfolio.html script tag load order
    // matters: lib/format.js must load before lib/calc.js so the toTWD /
    // fromTWD pull above resolves through root globals at IIFE-evaluation
    // time.
    root.Calc = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);