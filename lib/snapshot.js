// lib/snapshot.js — Portfolio snapshot construction (pure functions).
//
// Loaded by portfolio.html via <script src="lib/snapshot.js"> (browser globals).
// Also imported by tests/snapshot.test.js for Node.js testing (CommonJS).
//
// Source of truth for the L4 snapshot shape:
//   * ADR 0005 (L4 full-detail snapshot storage) — date / holdings /
//     cash_accounts / debts / fx_rate / totals / delta.
//   * ADR 0009 §7 — only current_price per holding; 52W + prev_close
//     are NOT included (kept stable across snapshots).
//
// API:
//   todayLocalISO(now)              → 'YYYY-MM-DD' string of `now`'s local date
//   isSameDay(a, b)                 → both are YYYY-MM-DD (or full ISO), same day?
//   computeTotals(holdings, cash, debts, fxRate, displayCurrency)
//                                   → { holdingsValue, holdingsCost,
//                                       holdingsGainLoss, totalCash,
//                                       totalDebts, netWorth,
//                                       displayCurrency }
//                                     Uses Calc.* helpers (lib/calc.js).
//   computeDelta(prevSnapshot, currentSnapshot)
//                                   → null if prev=null, else { perHolding,
//                                     netWorth, holdingsValue }
//   buildSnapshot(portfolio, { now, fxRate, prevSnapshot })
//                                   → full L4 snapshot object.
//
// Dependencies (cross-module): lib/serialize.js (stripInMemoryFields),
// lib/calc.js (Calc.*). Both loaded via <script> before this module in
// portfolio.html.

(function (root) {
  'use strict';

  const Serialize = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./serialize.js')
    : root.Serialize;
  const Calc = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./calc.js')
    : root.Calc;

  function todayLocalISO(now) {
    const d = (now instanceof Date) ? now : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isSameDay(a, b) {
    if (!a || !b) return false;
    // Strip time portion; compare YYYY-MM-DD.
    const dayOf = (s) => String(s).slice(0, 10);
    return dayOf(a) === dayOf(b);
  }

  function computeTotals(holdings, cash, debts, fxRate, displayCurrency) {
    return {
      displayCurrency,
      holdingsValue: Calc.holdingsValue(holdings, displayCurrency, fxRate),
      holdingsCost: Calc.holdingsCost(holdings, displayCurrency, fxRate),
      holdingsGainLoss: Calc.holdingsGainLoss(holdings, displayCurrency, fxRate),
      totalCash: Calc.totalCash(cash, displayCurrency, fxRate),
      totalDebts: Calc.totalDebts(debts, displayCurrency, fxRate),
      netWorth: Calc.netWorth(holdings, cash, debts, displayCurrency, fxRate),
    };
  }

  function computeDelta(prev, current) {
    if (!prev) return null;

    // Per-holding: for each holding present in BOTH prev and current,
    // record price delta and total (value) delta. Holdings that appear in
    // only one side don't have a meaningful per-holding delta (they're
    // buy / sell events, captured separately in totals delta below).
    const prevById = new Map();
    for (const h of (prev.holdings || [])) prevById.set(h.id, h);

    const perHolding = {};
    for (const h of (current.holdings || [])) {
      const p = prevById.get(h.id);
      if (!p) continue; // newly added — not a per-holding delta
      if (p.current_price == null || h.current_price == null) continue; // can't compute
      perHolding[h.id] = {
        priceDelta: h.current_price - p.current_price,
        totalDelta: (h.shares * h.current_price) - (p.shares * p.current_price),
      };
    }

    return {
      perHolding,
      netWorth: (current.totals?.netWorth ?? 0) - (prev.totals?.netWorth ?? 0),
      holdingsValue: (current.totals?.holdingsValue ?? 0) - (prev.totals?.holdingsValue ?? 0),
    };
  }

  function buildSnapshot(portfolio, opts) {
    const { now, fxRate, prevSnapshot } = opts || {};
    const displayCurrency = portfolio.settings?.display_currency || 'TWD';

    // Take a deep copy so we don't mutate the caller's portfolio object.
    // stripInMemoryFields walks nested objects and removes _refresh_failed
    // (and any future in-memory flags) so they never reach the snapshot.
    const cleaned = JSON.parse(JSON.stringify(portfolio));
    Serialize.stripInMemoryFields(cleaned);

    const holdings = cleaned.holdings || [];
    const cashAccounts = cleaned.cash_accounts || [];
    const debts = cleaned.debts || [];

    const totals = computeTotals(holdings, cashAccounts, debts, fxRate, displayCurrency);

    // Snapshot shape (per ADR 0005 + data-file-format.md §snapshots).
    // `id` is a stable identifier; mirrors the genId pattern used elsewhere
    // in the app so mergeById (sync) works on snapshots too.
    const snap = {
      id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      date: todayLocalISO(now),
      holdings,
      cash_accounts: cashAccounts,
      debts,
      fx_rate: fxRate,
      totals,
    };

    snap.delta = computeDelta(prevSnapshot, snap);
    return snap;
  }

  // pushSnapshotWithCap: pure FIFO helper for the snapshot cap
  // (v1.5 — .scratch/v1.5-snapshot-ui/issues/01-snapshot-cap-and-gc.md).
  //
  // Appends `snap` to a copy of `snapshots`, then if the cap is exceeded
  // drops the oldest entries from the front (FIFO). Treats null,
  // undefined, 0, non-finite, and non-number caps as "no cap" (cap 0 is
  // the explicit "unlimited" setting sentinel). Returns a new array;
  // never mutates the input.
  function pushSnapshotWithCap(snapshots, snap, cap) {
    const hasCap = Number.isFinite(cap) && cap > 0;
    if (!hasCap) {
      return [...snapshots, snap];
    }
    const next = [...snapshots, snap];
    if (next.length > cap) {
      return next.slice(next.length - cap);
    }
    return next;
  }

  // normalizeSnapshotCap: sanitization for load() lazy-init
  // (v1.5 — .scratch/v1.5-snapshot-ui/issues/01-snapshot-cap-and-gc.md).
  //
  // Returns:
  //   - 365 (default) when value is missing / negative / NaN / non-number
  //   - 0 (explicit unlimited) preserved as-is
  //   - positive integer kept as-is
  function normalizeSnapshotCap(value) {
    if (value === undefined) return 365;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 365;
    return value;
  }

  const api = {
    todayLocalISO,
    isSameDay,
    computeTotals,
    computeDelta,
    buildSnapshot,
    pushSnapshotWithCap,
    normalizeSnapshotCap,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Snapshot = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);