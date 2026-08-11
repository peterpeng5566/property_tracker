// tests/snapshot.test.js — tests for lib/snapshot.js (v1.2)
//
// Covers: todayLocalISO(), isSameDay(), buildSnapshot(),
// computeTotals(), computeDelta().
// Source of truth: lib/snapshot.js + ADR 0005 (L4 snapshot storage).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Snapshot = require('../lib/snapshot.js');
const { todayLocalISO, isSameDay, buildSnapshot, computeTotals, computeDelta } = Snapshot;

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