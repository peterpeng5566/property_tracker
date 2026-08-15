// tests/snapshot.test.js — tests for lib/snapshot.js (v1.2 + v1.5)
//
// Covers: todayLocalISO(), isSameDay(), buildSnapshot(),
// computeTotals(), computeDelta(), pushSnapshotWithCap(),
// normalizeSnapshotCap().
// Source of truth: lib/snapshot.js + ADR 0005 (L4 snapshot storage).
// v1.5 cap behavior: .scratch/v1.5-snapshot-ui/issues/01.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Snapshot = require('../lib/snapshot.js');
const {
  todayLocalISO,
  isSameDay,
  buildSnapshot,
  computeTotals,
  computeDelta,
  pushSnapshotWithCap,
  normalizeSnapshotCap,
} = Snapshot;

const iso = (s) => new Date(s).toISOString();
const H = (id, opts = {}) => ({
  id,
  ticker: opts.ticker || id,
  shares: opts.shares ?? 0,
  cost: opts.cost ?? 0,
  currency: opts.currency || 'TWD',
  current_price: opts.current_price ?? 0,
  attributes: opts.attributes || {},
  inactive: opts.inactive || false,
  updated_at: opts.updated_at || iso('2024-01-01'),
  device_id: opts.device_id || 'd1',
});
const C = (id, opts = {}) => ({
  id,
  name: opts.name || id,
  balance: opts.balance ?? 0,
  currency: opts.currency || 'TWD',
  attributes: opts.attributes || {},
  inactive: opts.inactive || false,
  updated_at: opts.updated_at || iso('2024-01-01'),
  device_id: opts.device_id || 'd1',
});

// --- todayLocalISO ---

test('todayLocalISO: returns a YYYY-MM-DD string', () => {
  const s = todayLocalISO();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});

test('todayLocalISO: accepts an injected Date', () => {
  // 2024-03-15 23:59 local
  const s = todayLocalISO(new Date(2024, 2, 15, 23, 59));
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.length, 10);
});

test('todayLocalISO: injected Date round-trips correctly', () => {
  // Pick a date far enough in the past/future to be unambiguous.
  const d = new Date(2023, 5, 7, 12, 0); // June 7, 2023 (month is 0-indexed)
  const s = todayLocalISO(d);
  assert.equal(s, '2023-06-07');
});

// --- isSameDay ---

test('isSameDay: identical YYYY-MM-DD strings → true', () => {
  assert.equal(isSameDay('2024-01-15', '2024-01-15'), true);
});

test('isSameDay: different days → false', () => {
  assert.equal(isSameDay('2024-01-15', '2024-01-16'), false);
  assert.equal(isSameDay('2024-01-15', '2024-02-15'), false);
  assert.equal(isSameDay('2024-01-15', '2023-01-15'), false);
});

test('isSameDay: accepts full ISO timestamps too (uses date portion)', () => {
  // Same calendar day, different times → same day
  assert.equal(
    isSameDay('2024-01-15T08:00:00Z', '2024-01-15T22:00:00Z'),
    true
  );
  // Different calendar days even if hours match → not same day
  assert.equal(
    isSameDay('2024-01-15T08:00:00Z', '2024-01-16T08:00:00Z'),
    false
  );
});

test('isSameDay: null/undefined inputs → false', () => {
  assert.equal(isSameDay(null, '2024-01-15'), false);
  assert.equal(isSameDay('2024-01-15', null), false);
  assert.equal(isSameDay(null, null), false);
});

// --- computeTotals ---

test('computeTotals: empty portfolio → zeros', () => {
  const t = computeTotals([], [], [], 32.2, 'TWD');
  assert.equal(t.netWorth, 0);
  assert.equal(t.holdingsValue, 0);
  assert.equal(t.holdingsCost, 0);
  assert.equal(t.totalCash, 0);
  assert.equal(t.totalDebts, 0);
});

test('computeTotals: returns totals in displayCurrency (TWD)', () => {
  const holdings = [H('a', { shares: 10, current_price: 100, currency: 'TWD' })];
  const t = computeTotals(holdings, [], [], 32.2, 'TWD');
  assert.equal(t.holdingsValue, 1000); // 10 * 100
  assert.equal(t.holdingsCost, 0);
  assert.equal(t.totalCash, 0);
  assert.equal(t.totalDebts, 0);
  assert.equal(t.netWorth, 1000);
  assert.equal(t.displayCurrency, 'TWD');
});

test('computeTotals: returns totals in displayCurrency (USD, FX applied)', () => {
  // 100 TWD worth, FX=32.2, so in USD = 100/32.2
  const holdings = [H('a', { shares: 1, current_price: 100, currency: 'TWD' })];
  const t = computeTotals(holdings, [], [], 32.2, 'USD');
  assert.equal(t.netWorth, 100 / 32.2);
  assert.equal(t.displayCurrency, 'USD');
});

test('computeTotals: USD native holding converts to TWD display via FX', () => {
  // 100 USD worth @ fx 32 → 3200 TWD (whole-number FX avoids float noise).
  const holdings = [H('a', { shares: 1, current_price: 100, currency: 'USD' })];
  const t = computeTotals(holdings, [], [], 32, 'TWD');
  assert.equal(t.holdingsValue, 3200);
  assert.equal(t.netWorth, 3200);
});

test('computeTotals: netWorth = holdingsValue + totalCash − totalDebts', () => {
  const holdings = [H('a', { shares: 10, current_price: 100, currency: 'TWD' })];
  const cash = [C('c1', { balance: 500, currency: 'TWD' })];
  const debts = [C('d1', { balance: 200, currency: 'TWD' })];
  const t = computeTotals(holdings, cash, debts, 32.2, 'TWD');
  assert.equal(t.holdingsValue, 1000);
  assert.equal(t.totalCash, 500);
  assert.equal(t.totalDebts, 200);
  assert.equal(t.netWorth, 1300); // 1000 + 500 − 200
});

test('computeTotals: inactive holdings/cash/debts excluded', () => {
  const holdings = [
    H('a', { shares: 10, current_price: 100, currency: 'TWD' }),
    H('b', { shares: 5, current_price: 200, currency: 'TWD', inactive: true }),
  ];
  const t = computeTotals(holdings, [], [], 32.2, 'TWD');
  assert.equal(t.holdingsValue, 1000); // b excluded
});

// --- buildSnapshot: structure + invariants ---

test('buildSnapshot: returns shape with date / holdings / cash_accounts / debts / fx_rate / totals / delta', () => {
  const portfolio = {
    settings: { display_currency: 'TWD', fx_rate: 32.2 },
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
    cash_accounts: [C('c1', { balance: 500, currency: 'TWD' })],
    debts: [],
  };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15, 10, 0), fxRate: 32.2, prevSnapshot: null });
  assert.match(snap.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(snap.holdings));
  assert.ok(Array.isArray(snap.cash_accounts));
  assert.ok(Array.isArray(snap.debts));
  assert.equal(typeof snap.fx_rate, 'number');
  assert.equal(snap.fx_rate, 32.2);
  assert.ok(snap.totals && typeof snap.totals.netWorth === 'number');
  // No prev → delta null or empty
  assert.ok(snap.delta === null || (typeof snap.delta === 'object' && Object.keys(snap.delta).length === 0));
});

test('buildSnapshot: todayLocalISO used for date (injected now)', () => {
  const portfolio = { settings: { display_currency: 'TWD' }, holdings: [], cash_accounts: [], debts: [] };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 5, 7, 23, 59), fxRate: 32.2, prevSnapshot: null });
  assert.equal(snap.date, '2024-06-07');
});

test('buildSnapshot: holdings retain current_price in snapshot (for historical charting)', () => {
  const portfolio = {
    settings: { display_currency: 'TWD' },
    holdings: [H('a', { shares: 10, current_price: 150, currency: 'TWD' })],
    cash_accounts: [],
    debts: [],
  };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  assert.equal(snap.holdings.length, 1);
  assert.equal(snap.holdings[0].current_price, 150);
  assert.equal(snap.holdings[0].shares, 10);
});

test('buildSnapshot: _refresh_failed flag is stripped (via Serialize.stripInMemoryFields)', () => {
  const portfolio = {
    settings: { display_currency: 'TWD' },
    holdings: [
      H('a', { shares: 10, current_price: 100, currency: 'TWD' }),
      { ...H('b', { shares: 5, current_price: 200, currency: 'TWD' }), _refresh_failed: true },
    ],
    cash_accounts: [],
    debts: [],
  };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  for (const h of snap.holdings) {
    assert.equal(h._refresh_failed, undefined);
  }
  // And after round-trip through JSON (which is what gets persisted), the flag is gone.
  const roundTripped = JSON.parse(JSON.stringify(snap));
  for (const h of roundTripped.holdings) {
    assert.equal(h._refresh_failed, undefined);
  }
});

test('buildSnapshot: missing settings defaults to TWD display', () => {
  const portfolio = {
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
  };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  assert.equal(snap.totals.displayCurrency, 'TWD');
  assert.equal(snap.totals.holdingsValue, 1000);
});

test('buildSnapshot: snapshot has a stable id', () => {
  const portfolio = { settings: { display_currency: 'TWD' }, holdings: [], cash_accounts: [], debts: [] };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  assert.match(snap.id, /^snap-\d+-[a-z0-9]+$/);
});

test('buildSnapshot: snapshot is a new object (does not mutate portfolio)', () => {
  const holdings = [H('a', { shares: 10, current_price: 100, currency: 'TWD' })];
  const portfolio = { settings: { display_currency: 'TWD' }, holdings, cash_accounts: [], debts: [] };
  const beforeLen = portfolio.holdings.length;
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  assert.notEqual(snap.holdings, portfolio.holdings); // different reference
  assert.equal(portfolio.holdings.length, beforeLen); // not mutated
});

// --- buildSnapshot: delta ---

test('buildSnapshot: no prevSnapshot → delta is null or empty', () => {
  const portfolio = { settings: { display_currency: 'TWD' }, holdings: [], cash_accounts: [], debts: [] };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: null });
  assert.ok(snap.delta === null || (typeof snap.delta === 'object' && Object.keys(snap.delta).length === 0));
});

test('buildSnapshot: with prevSnapshot → delta computed per-holding and per-total', () => {
  const prev = {
    date: '2024-01-14',
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
    cash_accounts: [],
    debts: [],
    fx_rate: 32.2,
    totals: {
      holdingsValue: 1000,
      netWorth: 1000,
      displayCurrency: 'TWD',
    },
  };
  const portfolio = {
    settings: { display_currency: 'TWD' },
    holdings: [H('a', { shares: 10, current_price: 110, currency: 'TWD' })], // price up 10
    cash_accounts: [],
    debts: [],
  };
  const snap = buildSnapshot(portfolio, { now: new Date(2024, 0, 15), fxRate: 32.2, prevSnapshot: prev });

  assert.ok(snap.delta !== null, 'delta should not be null when prev exists');
  // Per-holding delta
  assert.ok(snap.delta.perHolding, 'delta.perHolding should exist');
  assert.ok(snap.delta.perHolding.a, 'per-holding delta for a should exist');
  assert.equal(snap.delta.perHolding.a.priceDelta, 10); // 110 - 100
  // Per-total delta
  assert.equal(snap.delta.netWorth, 100); // 1100 - 1000
  assert.equal(snap.delta.holdingsValue, 100);
});

// --- computeDelta (direct) ---

test('computeDelta: prev=null → returns null', () => {
  const cur = { holdings: [], totals: { netWorth: 100 } };
  assert.equal(computeDelta(null, cur), null);
});

test('computeDelta: prev given → per-holding + per-total delta', () => {
  const prev = {
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
    totals: { netWorth: 1000, holdingsValue: 1000, displayCurrency: 'TWD' },
  };
  const cur = {
    holdings: [H('a', { shares: 10, current_price: 110, currency: 'TWD' })],
    totals: { netWorth: 1100, holdingsValue: 1100, displayCurrency: 'TWD' },
  };
  const d = computeDelta(prev, cur);
  assert.equal(d.perHolding.a.priceDelta, 10);
  assert.equal(d.netWorth, 100);
  assert.equal(d.holdingsValue, 100);
});

test('computeDelta: holding absent from current → not in perHolding', () => {
  const prev = {
    holdings: [
      H('a', { shares: 10, current_price: 100, currency: 'TWD' }),
      H('b', { shares: 5, current_price: 200, currency: 'TWD' }),
    ],
    totals: { netWorth: 2000, holdingsValue: 2000 },
  };
  const cur = {
    holdings: [H('a', { shares: 10, current_price: 110, currency: 'TWD' })], // b sold
    totals: { netWorth: 1100, holdingsValue: 1100 },
  };
  const d = computeDelta(prev, cur);
  assert.ok(d.perHolding.a);
  assert.equal(d.perHolding.b, undefined);
});

test('computeDelta: holding absent from prev → not in perHolding', () => {
  const prev = {
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
    totals: { netWorth: 1000, holdingsValue: 1000 },
  };
  const cur = {
    holdings: [
      H('a', { shares: 10, current_price: 110, currency: 'TWD' }),
      H('b', { shares: 5, current_price: 50, currency: 'TWD' }), // new
    ],
    totals: { netWorth: 1350, holdingsValue: 1350 },
  };
  const d = computeDelta(prev, cur);
  assert.ok(d.perHolding.a);
  assert.equal(d.perHolding.b, undefined);
});

// --- v1.5 ticket 04: computeDelta must expose all 5 totals deltas
// (Q1 = A: pure helper is the source of truth; UI is a thin shim) ---

test('computeDelta: returns all 5 totals deltas (value, cost, gainLoss, cash, debts)', () => {
  const prev = {
    holdings: [H('a', { shares: 10, current_price: 100, currency: 'TWD' })],
    cash_accounts: [C('c1', { balance: 500, currency: 'TWD' })],
    debts: [C('d1', { balance: 1000, currency: 'TWD' })],
    totals: {
      holdingsValue: 1000, holdingsCost: 800, holdingsGainLoss: 200,
      totalCash: 500, totalDebts: 1000, netWorth: 500,
    },
  };
  const cur = {
    holdings: [H('a', { shares: 10, current_price: 110, currency: 'TWD' })],
    cash_accounts: [C('c1', { balance: 800, currency: 'TWD' })],
    debts: [C('d1', { balance: 600, currency: 'TWD' })],
    totals: {
      holdingsValue: 1100, holdingsCost: 800, holdingsGainLoss: 300,
      totalCash: 800, totalDebts: 600, netWorth: 1300,
    },
  };
  const d = computeDelta(prev, cur);
  assert.equal(d.holdingsValue, 100);     // 1100 - 1000
  assert.equal(d.holdingsCost, 0);        // 800 - 800
  assert.equal(d.holdingsGainLoss, 100);  // 300 - 200
  assert.equal(d.totalCash, 300);         // 800 - 500
  assert.equal(d.totalDebts, -400);       // 600 - 1000
  assert.equal(d.netWorth, 800);          // 1300 - 500
});

test('computeDelta: new totals fields are independent of perHolding (missing price doesn\'t zero totals)', () => {
  // Inline holdings (don't use H helper, which coerces null → 0).
  const nullPriceHolding = { id: 'a', shares: 10, cost: 1000, currency: 'TWD', current_price: null, attributes: {} };
  const prev = {
    holdings: [nullPriceHolding],
    cash_accounts: [C('c1', { balance: 500, currency: 'TWD' })],
    debts: [],
    totals: { holdingsValue: 0, holdingsCost: 1000, totalCash: 500, totalDebts: 0, netWorth: 500 },
  };
  const cur = {
    holdings: [{ ...nullPriceHolding }],
    cash_accounts: [C('c1', { balance: 800, currency: 'TWD' })],
    debts: [],
    totals: { holdingsValue: 0, holdingsCost: 1000, totalCash: 800, totalDebts: 0, netWorth: 800 },
  };
  const d = computeDelta(prev, cur);
  assert.equal(d.perHolding.a, undefined); // price null on both → skipped
  assert.equal(d.totalCash, 300);
  assert.equal(d.netWorth, 300);
});

// --- v1.5: pushSnapshotWithCap + normalizeSnapshotCap ---
// T01: snapshot cap is FIFO; cap 0 = unlimited; helper is pure.
// See .scratch/v1.5-snapshot-ui/issues/01-snapshot-cap-and-gc.md.

const S = (id, opts = {}) => ({
  id,
  date: opts.date || '2024-01-15',
  holdings: [],
  cash_accounts: [],
  debts: [],
  fx_rate: opts.fx_rate != null ? opts.fx_rate : 32.2,
  totals: opts.totals || { netWorth: 0, holdingsValue: 0, displayCurrency: 'TWD' },
});

test('pushSnapshotWithCap: cap null → no cap applied (just push)', () => {
  const arr = [S('s1'), S('s2')];
  const out = pushSnapshotWithCap(arr, S('s3'), null);
  assert.equal(out.length, 3);
  assert.equal(out[2].id, 's3');
  assert.notEqual(out, arr); // immutable
  assert.equal(arr.length, 2); // input not mutated
});

test('pushSnapshotWithCap: cap undefined → no cap applied', () => {
  const arr = [S('s1')];
  const out = pushSnapshotWithCap(arr, S('s2'), undefined);
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 's2');
  assert.equal(arr.length, 1);
});

test('pushSnapshotWithCap: cap 0 → no cap applied (0 = unlimited)', () => {
  const arr = [S('s1'), S('s2')];
  const out = pushSnapshotWithCap(arr, S('s3'), 0);
  assert.equal(out.length, 3);
  assert.equal(out[2].id, 's3');
  assert.equal(arr.length, 2);
});

test('pushSnapshotWithCap: cap 1 → keeps only the most recent', () => {
  const arr = [S('s1'), S('s2'), S('s3')];
  const out = pushSnapshotWithCap(arr, S('s4'), 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 's4');
  assert.equal(arr.length, 3); // input not mutated
});

test('pushSnapshotWithCap: cap 3 with 5 pushes → keeps last 3, drops oldest 2', () => {
  let arr = [];
  for (let i = 1; i <= 5; i++) {
    arr = pushSnapshotWithCap(arr, S(`s${i}`), 3);
  }
  assert.equal(arr.length, 3);
  assert.equal(arr[0].id, 's3'); // oldest kept
  assert.equal(arr[1].id, 's4');
  assert.equal(arr[2].id, 's5'); // newest
});

test('pushSnapshotWithCap: cap not exceeded → returns new array of length+1', () => {
  const arr = [S('s1'), S('s2')];
  const out = pushSnapshotWithCap(arr, S('s3'), 5);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 's1');
  assert.equal(out[1].id, 's2');
  assert.equal(out[2].id, 's3');
  assert.notEqual(out, arr); // immutable
  assert.equal(arr.length, 2);
});

test('pushSnapshotWithCap: cap exactly equal → push then trim to cap', () => {
  const arr = [S('s1'), S('s2'), S('s3')]; // length 3, cap 3
  const out = pushSnapshotWithCap(arr, S('s4'), 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 's2'); // s1 dropped
  assert.equal(out[1].id, 's3');
  assert.equal(out[2].id, 's4');
  assert.equal(arr.length, 3); // input not mutated
});

test('pushSnapshotWithCap: empty input array → returns just the new snap', () => {
  const out = pushSnapshotWithCap([], S('s1'), 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 's1');
});

test('pushSnapshotWithCap: never mutates input array', () => {
  const arr = [S('s1'), S('s2')];
  const snap = S('s3');
  pushSnapshotWithCap(arr, snap, 1);
  pushSnapshotWithCap(arr, snap, 0);
  pushSnapshotWithCap(arr, snap, null);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].id, 's1');
  assert.equal(arr[1].id, 's2');
});

test('pushSnapshotWithCap: defensive — negative cap treated as no cap', () => {
  const arr = [S('s1')];
  const out = pushSnapshotWithCap(arr, S('s2'), -5);
  assert.equal(out.length, 2); // no cap applied
  assert.equal(out[1].id, 's2');
});

test('pushSnapshotWithCap: defensive — NaN cap treated as no cap', () => {
  const arr = [S('s1')];
  const out = pushSnapshotWithCap(arr, S('s2'), NaN);
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 's2');
});

test('pushSnapshotWithCap: defensive — non-number cap treated as no cap', () => {
  const arr = [S('s1')];
  const out = pushSnapshotWithCap(arr, S('s2'), '365');
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 's2');
});

// --- normalizeSnapshotCap ---

test('normalizeSnapshotCap: undefined → 365 (default)', () => {
  assert.equal(normalizeSnapshotCap(undefined), 365);
});

test('normalizeSnapshotCap: 0 → 0 (explicit unlimited preserved)', () => {
  assert.equal(normalizeSnapshotCap(0), 0);
});

test('normalizeSnapshotCap: positive integer → kept as-is', () => {
  assert.equal(normalizeSnapshotCap(365), 365);
  assert.equal(normalizeSnapshotCap(1), 1);
  assert.equal(normalizeSnapshotCap(10000), 10000);
});

test('normalizeSnapshotCap: negative → 365 (reject)', () => {
  assert.equal(normalizeSnapshotCap(-5), 365);
  assert.equal(normalizeSnapshotCap(-1), 365);
});

test('normalizeSnapshotCap: NaN → 365 (reject)', () => {
  assert.equal(normalizeSnapshotCap(NaN), 365);
});

test('normalizeSnapshotCap: non-number → 365 (reject)', () => {
  assert.equal(normalizeSnapshotCap('365'), 365);
  assert.equal(normalizeSnapshotCap(null), 365);
  assert.equal(normalizeSnapshotCap({}), 365);
});

// ---------------------------------------------------------------------------
// resolveAttributeRef (v1.5 ticket 03)
// Pure helper that maps (catId, valId) to a renderable label + a 'kind' that
// the UI uses to pick a glyph (ADR 0003 — category values are live, but old
// snapshots may reference ids that have since been deleted).
// ---------------------------------------------------------------------------

test('resolveAttributeRef: valid cat + valid val → ok with value name', () => {
  const cats = [{ id: 'c-country', values: [{ id: 'v-us', name: 'US' }, { id: 'v-tw', name: 'TW' }] }];
  const out = Snapshot.resolveAttributeRef(cats, 'c-country', 'v-us');
  assert.equal(out.kind, 'ok');
  assert.equal(out.label, 'US');
  assert.equal(out.hintKey, null);
});

test('resolveAttributeRef: valid cat + missing val → orphanValue with "?"', () => {
  const cats = [{ id: 'c-country', values: [{ id: 'v-us', name: 'US' }] }];
  const out = Snapshot.resolveAttributeRef(cats, 'c-country', 'v-deleted');
  assert.equal(out.kind, 'orphanValue');
  assert.equal(out.label, '?');
  assert.equal(out.hintKey, 'snapshots.detail.orphanValue');
});

test('resolveAttributeRef: missing cat → orphanCategory with "—"', () => {
  const cats = [{ id: 'c-country', values: [{ id: 'v-us', name: 'US' }] }];
  const out = Snapshot.resolveAttributeRef(cats, 'c-deleted-cat', 'v-us');
  assert.equal(out.kind, 'orphanCategory');
  assert.equal(out.label, '—');
  assert.equal(out.hintKey, 'snapshots.detail.orphanCategory');
});

test('resolveAttributeRef: empty categories array → orphanCategory', () => {
  const out = Snapshot.resolveAttributeRef([], 'c-country', 'v-us');
  assert.equal(out.kind, 'orphanCategory');
  assert.equal(out.label, '—');
});

test('resolveAttributeRef: category with empty values array → orphanValue', () => {
  const cats = [{ id: 'c-country', values: [] }];
  const out = Snapshot.resolveAttributeRef(cats, 'c-country', 'v-us');
  assert.equal(out.kind, 'orphanValue');
  assert.equal(out.label, '?');
});

test('resolveAttributeRef: returns a fresh object each call (no shared mutable state)', () => {
  const cats = [{ id: 'c-country', values: [{ id: 'v-us', name: 'US' }] }];
  const a = Snapshot.resolveAttributeRef(cats, 'c-country', 'v-us');
  const b = Snapshot.resolveAttributeRef(cats, 'c-country', 'v-us');
  assert.notEqual(a, b);
  a.kind = 'tampered';
  assert.equal(b.kind, 'ok');
});

// --- v1.5 ticket 05: toDisplaySeries for sparkline ---
// TDD seam: lib/snapshot.js. Pure helper that converts each snap's
// frozen netWorth / holdingsValue into the *current* display_currency
// using each snap's own frozen fx_rate (NOT the current fx_rate).
// Sorted ascending by date (oldest first; chart x-axis is left-to-right
// time progression).
// See .scratch/v1.5-snapshot-ui/issues/05-trend-chart-sparkline.md.

test('toDisplaySeries: empty array → []', () => {
  assert.deepEqual(Snapshot.toDisplaySeries([], 'TWD'), []);
});

test('toDisplaySeries: non-array input → [] (defensive)', () => {
  assert.deepEqual(Snapshot.toDisplaySeries(null, 'TWD'), []);
  assert.deepEqual(Snapshot.toDisplaySeries(undefined, 'TWD'), []);
});

test('toDisplaySeries: single TWD snapshot passes through unchanged', () => {
  const out = Snapshot.toDisplaySeries(
    [S('s1', { totals: { displayCurrency: 'TWD', holdingsValue: 80_000, netWorth: 150_000 } })],
    'TWD'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 's1');
  assert.equal(out[0].date, '2024-01-15');
  assert.equal(out[0].netWorth, 150_000);
  assert.equal(out[0].holdingsValue, 80_000);
});

test('toDisplaySeries: USD snapshot converted to TWD using its own fx_rate', () => {
  // fx_rate = 31 → 5000 USD * 31 = 155,000 TWD
  const out = Snapshot.toDisplaySeries(
    [S('s-usd', { fx_rate: 31,
      totals: { displayCurrency: 'USD', holdingsValue: 3_000, netWorth: 5_000 } })],
    'TWD'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].netWorth, 155_000);
  assert.equal(out[0].holdingsValue, 93_000); // 3000 * 31
});

test('toDisplaySeries: TWD snapshot converted to USD using its own fx_rate', () => {
  // fx_rate = 32 → 150,000 TWD / 32 = 4,687.50 USD
  const out = Snapshot.toDisplaySeries(
    [S('s-twd', { fx_rate: 32,
      totals: { displayCurrency: 'TWD', holdingsValue: 80_000, netWorth: 150_000 } })],
    'USD'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].netWorth, 150_000 / 32);
  assert.equal(out[0].holdingsValue, 80_000 / 32);
});

test('toDisplaySeries: sorted ascending by date (oldest first)', () => {
  // Input intentionally reversed to prove the sort.
  const out = Snapshot.toDisplaySeries([
    S('newest', { date: '2025-03-15',
      totals: { displayCurrency: 'TWD', holdingsValue: 100, netWorth: 300 } }),
    S('mid',    { date: '2025-02-10',
      totals: { displayCurrency: 'TWD', holdingsValue: 100, netWorth: 200 } }),
    S('oldest', { date: '2025-01-05',
      totals: { displayCurrency: 'TWD', holdingsValue: 100, netWorth: 100 } }),
  ], 'TWD');
  assert.deepEqual(out.map(s => s.id), ['oldest', 'mid', 'newest']);
  assert.deepEqual(out.map(s => s.netWorth), [100, 200, 300]);
});

test('toDisplaySeries: same-currency cross-snap (USD throughout) uses each snap frozen fx_rate', () => {
  // Two USD snapshots with different fx_rates. Each conversion uses its
  // OWN fx_rate (not the most recent one).
  const out = Snapshot.toDisplaySeries([
    S('a', { fx_rate: 31, date: '2024-01-01',
      totals: { displayCurrency: 'USD', holdingsValue: 1_000, netWorth: 1_000 } }),
    S('b', { fx_rate: 32, date: '2025-01-01',
      totals: { displayCurrency: 'USD', holdingsValue: 1_000, netWorth: 1_000 } }),
  ], 'TWD');
  assert.equal(out[0].netWorth, 31_000); // * 31
  assert.equal(out[1].netWorth, 32_000); // * 32
});

test('toDisplaySeries: missing totals / fx_rate defended with 0 and identity', () => {
  const out = Snapshot.toDisplaySeries([
    // No totals field at all
    { id: 'bare', date: '2024-01-15', holdings: [], cash_accounts: [], debts: [] },
    // Totals but missing fx_rate → uses 1 (identity for USD↔TWD via *1 /1)
    { id: 'no-fx', date: '2024-02-15', holdings: [], cash_accounts: [], debts: [],
      totals: { displayCurrency: 'TWD', holdingsValue: 50, netWorth: 50 } },
  ], 'TWD');
  assert.equal(out.length, 2);
  assert.equal(out[0].netWorth, 0);
  assert.equal(out[0].holdingsValue, 0);
  assert.equal(out[1].netWorth, 50);
});

test('toDisplaySeries: returns new array (does not mutate input)', () => {
  const input = [
    S('a', { date: '2024-01-01',
      totals: { displayCurrency: 'TWD', holdingsValue: 1, netWorth: 1 } }),
  ];
  const before = JSON.stringify(input);
  Snapshot.toDisplaySeries(input, 'TWD');
  assert.equal(JSON.stringify(input), before);
});
