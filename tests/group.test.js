// tests/group.test.js — tests for lib/group.js (v1.2)
//
// Covers: holdingsGroupedBy / cashGroupedBy / debtsGroupedBy and the
// private _groupBy helper (via the three public entry points).
// Source of truth: lib/group.js + .scratch/v1.2-testing-safety-net/
//   issues/05-lib-group-extraction.md
//
// Behaviour pinned here is the "no semantic change" baseline from the
// inline _groupBy() that lives in portfolio.html prior to ticket 05.
// FX-conversion rules come from lib/format.js (window.toTWD) — we pass
// fxRate explicitly so tests don't need a browser.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  holdingsGroupedBy,
  cashGroupedBy,
  debtsGroupedBy,
} = require('../lib/group.js');

// ---- Test fixtures ----

// Category id "sector" with two values (tech / finance).
const SECTOR_CAT = {
  id: 'sector',
  name: 'Sector',
  applies_to: ['holding'],
  values: [
    { id: 'tech', name: 'Tech' },
    { id: 'finance', name: 'Finance' },
  ],
};

// fxRate: 1 USD = 32 TWD.
const FX = 32;

function makeCategories(...cats) {
  return cats;
}

// ---- _groupBy via holdingsGroupedBy ----

test('holdingsGroupedBy: category not found → []', () => {
  const out = holdingsGroupedBy([], makeCategories(SECTOR_CAT), 'unknown');
  assert.deepEqual(out, []);
});

test('holdingsGroupedBy: category present but no records reference it → []', () => {
  // Empty holdings list (after inactive filter).
  const out = holdingsGroupedBy([], makeCategories(SECTOR_CAT), 'sector', FX);
  // Spec says category-not-found and category-with-no-records both → []
  // (the inline code returns Object.values(groups).sort(...) which would
  // give all-empty buckets, not []. We keep the spec semantics.)
  assert.deepEqual(out, []);
});

test('holdingsGroupedBy: non-empty holdings but no record references the category → []', () => {
  // All records have attributes[catId] pointing at value ids not in
  // cat.values → all silently dropped → no bucket has count > 0 → [].
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'energy' } },
    { shares: 5,  current_price: 50,  currency: 'TWD', attributes: { sector: 'mining' } },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.deepEqual(out, []);
});

test('holdingsGroupedBy: single record with no attribute → one _unassigned bucket', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: {} },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].value_id, '_unassigned');
  assert.equal(out[0].value_name, '— Unassigned');
  assert.equal(out[0].count, 1);
  assert.equal(out[0].total, 1000); // 10 * 100 = 1000 TWD (native already)
});

test('holdingsGroupedBy: three records across two values → two buckets', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'tech' } },
    { shares: 5,  current_price: 200, currency: 'TWD', attributes: { sector: 'tech' } },
    { shares: 4,  current_price: 50,  currency: 'TWD', attributes: { sector: 'finance' } },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.equal(out.length, 2);
  const byId = Object.fromEntries(out.map(g => [g.value_id, g]));
  assert.equal(byId.tech.count, 2);
  assert.equal(byId.tech.total, 10 * 100 + 5 * 200); // 1000 + 1000 = 2000 TWD
  assert.equal(byId.finance.count, 1);
  assert.equal(byId.finance.total, 4 * 50); // 200 TWD
});

test('holdingsGroupedBy: inactive records excluded', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', inactive: true, attributes: { sector: 'tech' } },
    { shares: 4,  current_price: 50,  currency: 'TWD', attributes: { sector: 'tech' } },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  const tech = out.find(g => g.value_id === 'tech');
  assert.equal(tech.count, 1);
  assert.equal(tech.total, 200);
});

test('holdingsGroupedBy: attribute pointing at non-existent value id → silently dropped', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'tech' } },
    // 'energy' is not in SECTOR_CAT.values → dropped, not _unassigned.
    { shares: 4,  current_price: 50,  currency: 'TWD', attributes: { sector: 'energy' } },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].value_id, 'tech');
  assert.equal(out[0].count, 1);
  assert.equal(out[0].total, 1000);
  // No _unassigned bucket because no record falls into it.
  assert.equal(out.find(g => g.value_id === '_unassigned'), undefined);
});

test('holdingsGroupedBy: sorted by total descending; _unassigned always last', () => {
  const holdings = [
    { shares: 1, current_price: 10, currency: 'TWD', attributes: { sector: 'finance' } },    // 10
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'tech' } },    // 1000
    { shares: 1, current_price: 50, currency: 'TWD', attributes: {} },                        // 50 → _unassigned
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.equal(out.length, 3);
  assert.equal(out[0].value_id, 'tech');
  assert.equal(out[1].value_id, 'finance');
  assert.equal(out[2].value_id, '_unassigned');
});

test('holdingsGroupedBy: mixed TWD/USD totals are converted to TWD via fxRate', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'tech' } },     // 1000 TWD
    { shares: 5,  current_price: 10,  currency: 'USD', attributes: { sector: 'tech' } },     // 5*10*32 = 1600 TWD
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  const tech = out.find(g => g.value_id === 'tech');
  assert.equal(tech.count, 2);
  assert.equal(tech.total, 2600); // 1000 + 1600
});

test('holdingsGroupedBy: only the catId column matters; other attribute keys ignored', () => {
  const holdings = [
    {
      shares: 10, current_price: 100, currency: 'TWD',
      attributes: { sector: 'tech', region: 'asia' }, // 'region' isn't a category we pass in.
    },
  ];
  const out = holdingsGroupedBy(holdings, makeCategories(SECTOR_CAT), 'sector', FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].value_id, 'tech');
});

test('holdingsGroupedBy: empty categories list → []', () => {
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: { sector: 'tech' } },
  ];
  const out = holdingsGroupedBy(holdings, [], 'sector', FX);
  assert.deepEqual(out, []);
});

test('holdingsGroupedBy: category with no values → only _unassigned bucket', () => {
  const cat = { id: 'sector', name: 'Sector', applies_to: ['holding'], values: [] };
  const holdings = [
    { shares: 10, current_price: 100, currency: 'TWD', attributes: {} },
    { shares: 5,  current_price: 50,  currency: 'TWD', attributes: { sector: 'tech' } }, // dropped — no values defined
  ];
  const out = holdingsGroupedBy(holdings, [cat], 'sector', FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].value_id, '_unassigned');
  assert.equal(out[0].count, 1);
  assert.equal(out[0].total, 1000);
});

// ---- _groupBy via cashGroupedBy ----

test('cashGroupedBy: groups cash_accounts by attribute, totals = sum of balances in TWD', () => {
  const categories = [
    { id: 'type', name: 'Type', values: [{ id: 'savings', name: 'Savings' }, { id: 'checking', name: 'Checking' }] },
  ];
  const cash = [
    { balance: 5000, currency: 'TWD', attributes: { type: 'savings' } },
    { balance: 3000, currency: 'TWD', attributes: { type: 'savings' } },
    { balance: 100,  currency: 'USD', attributes: { type: 'checking' } }, // 100 * 32 = 3200 TWD
  ];
  const out = cashGroupedBy(cash, categories, 'type', FX);
  const byId = Object.fromEntries(out.map(g => [g.value_id, g]));
  assert.equal(byId.savings.count, 2);
  assert.equal(byId.savings.total, 8000);
  assert.equal(byId.checking.count, 1);
  assert.equal(byId.checking.total, 3200);
});

// ---- _groupBy via debtsGroupedBy ----

test('debtsGroupedBy: groups debts by attribute, totals = sum of balances in TWD', () => {
  const categories = [
    { id: 'kind', name: 'Kind', values: [{ id: 'card', name: 'Card' }, { id: 'mortgage', name: 'Mortgage' }] },
  ];
  const debts = [
    { balance: 20000, currency: 'TWD', attributes: { kind: 'card' } },
    { balance: 800,   currency: 'USD', attributes: { kind: 'mortgage' } }, // 800 * 32 = 25600 TWD
  ];
  const out = debtsGroupedBy(debts, categories, 'kind', FX);
  const byId = Object.fromEntries(out.map(g => [g.value_id, g]));
  assert.equal(byId.card.count, 1);
  assert.equal(byId.card.total, 20000);
  assert.equal(byId.mortgage.count, 1);
  assert.equal(byId.mortgage.total, 25600);
});

// ---- Cross-record sanity ----

test('all three group functions handle the same input shape consistently', () => {
  const categories = [{ id: 'tag', name: 'Tag', values: [{ id: 'a', name: 'A' }] }];
  const attrs = { tag: 'a' };
  const h = holdingsGroupedBy([{ shares: 1, current_price: 100, currency: 'TWD', attributes: attrs }], categories, 'tag', FX);
  const c = cashGroupedBy([{ balance: 100, currency: 'TWD', attributes: attrs }], categories, 'tag', FX);
  const d = debtsGroupedBy([{ balance: 100, currency: 'TWD', attributes: attrs }], categories, 'tag', FX);
  assert.equal(h[0].total, 100);
  assert.equal(c[0].total, 100);
  assert.equal(d[0].total, 100);
});
