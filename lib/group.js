// lib/group.js — pure category-grouping helpers (v1.2).
//
// Loaded by portfolio.html via <script src="lib/group.js"> (browser globals).
// Also imported by tests/group.test.js for Node.js testing (CommonJS).
//
// Source of truth for the Home page group-by buckets. Three public entry
// points (holdingsGroupedBy / cashGroupedBy / debtsGroupedBy) all delegate
// to the private _groupBy(items, categories, catId, totalFn, fxRate) so
// the per-record totalFn is the only thing that varies.
//
// Bucket totals are always in TWD — totals across mixed currencies are
// FX-converted via lib/format.js toTWD using the fxRate the caller passes
// in (the Alpine shim passes `this.fxRate()`, tests pass an explicit rate).
//
// Spec: .scratch/v1.2-testing-safety-net/issues/05-lib-group-extraction.md.

(function (root) {
  'use strict';

  // Pull FX conversion rule from lib/format.js so the rule lives in one place.
  // Node: require() the module. Browser: format.js already exposed toTWD on
  // the global root via its own IIFE.
  const { toTWD } = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./format.js')
    : { toTWD: root.toTWD };

  // Placeholder shown for the "_unassigned" bucket. The Alpine shim replaces
  // this with the localized string from the i18n catalog after the call,
  // so tests can pin the lib's contract without dragging in i18n state.
  const UNASSIGNED_LABEL = '— Unassigned';

  // ---- private ----

  // items: array of records (holdings / cash_accounts / debts)
  // categories: array of category objects
  // catId: id of the category to group by
  // totalFn: (item) → amount in item.currency (the per-record contribution)
  // fxRate: USD→TWD rate (1 USD = fxRate TWD)
  //
  // Returns: array of {value_id, value_name, total, count} buckets, sorted
  //   by total desc with _unassigned always last. Buckets with count === 0
  //   are dropped (so "category present but no records reference it" → []).
  // Records whose attributes[catId] points at a value id that is not in
  // cat.values are silently dropped from all buckets (matches current
  // inline behavior).
  function _groupBy(items, categories, catId, totalFn, fxRate) {
    const cat = (categories || []).find(c => c.id === catId);
    if (!cat) return [];

    const groups = {};
    (cat.values || []).forEach(v => {
      groups[v.id] = { value_id: v.id, value_name: v.name, total: 0, count: 0 };
    });
    groups._unassigned = {
      value_id: '_unassigned',
      value_name: UNASSIGNED_LABEL,
      total: 0,
      count: 0,
    };

    (items || []).filter(item => !item.inactive).forEach(item => {
      const key = (item.attributes && item.attributes[catId]) || '_unassigned';
      if (groups[key]) {
        groups[key].total += toTWD(totalFn(item), item.currency, fxRate);
        groups[key].count += 1;
      }
      // else: attribute points at a value id not in cat.values → silently dropped.
    });

    // Drop empty buckets (so "category present but no records reference it"
    // collapses to [] instead of [tech={0,0}, finance={0,0}, _unassigned={0,0}]).
    return Object.values(groups)
      .filter(g => g.count > 0)
      .sort((a, b) => {
        if (a.value_id === '_unassigned') return 1;
        if (b.value_id === '_unassigned') return -1;
        return b.total - a.total;
      });
  }

  // ---- public ----

  function holdingsGroupedBy(holdings, categories, catId, fxRate) {
    return _groupBy(holdings, categories, catId, h => h.shares * h.current_price, fxRate);
  }

  function cashGroupedBy(cashAccounts, categories, catId, fxRate) {
    return _groupBy(cashAccounts, categories, catId, c => c.balance, fxRate);
  }

  function debtsGroupedBy(debts, categories, catId, fxRate) {
    return _groupBy(debts, categories, catId, d => d.balance, fxRate);
  }

  const api = {
    holdingsGroupedBy,
    cashGroupedBy,
    debtsGroupedBy,
    // Expose the placeholder so the Alpine shim knows what to replace.
    UNASSIGNED_LABEL,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html). Load order: lib/format.js → lib/group.js
    // so the toTWD pull above resolves through root globals.
    root.Group = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
