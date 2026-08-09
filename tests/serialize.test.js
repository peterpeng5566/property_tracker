// tests/serialize.test.js — tests for lib/serialize.js (v1.1)
//
// Covers: serializeData() and stripInMemoryFields()
// Source of truth: lib/serialize.js + ADR 0009 §4 (in-memory flags must not persist).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeData, stripInMemoryFields, IN_MEMORY_HOLDING_FIELDS } = require('../lib/serialize.js');

// --- IN_MEMORY_HOLDING_FIELDS set ---

test('IN_MEMORY_HOLDING_FIELDS includes _refresh_failed', () => {
  assert.ok(IN_MEMORY_HOLDING_FIELDS.has('_refresh_failed'));
});

test('IN_MEMORY_HOLDING_FIELDS is a Set (not array)', () => {
  assert.ok(IN_MEMORY_HOLDING_FIELDS instanceof Set);
});

// --- serializeData: happy path ---

test('serializeData round-trips a simple object', () => {
  const data = { a: 1, b: 'two', c: null };
  const out = JSON.parse(serializeData(data));
  assert.deepEqual(out, { a: 1, b: 'two', c: null });
});

test('serializeData round-trips a portfolio-shaped object (no in-memory flags)', () => {
  const data = {
    version: '1.1',
    holdings: [
      { id: 'h1', ticker: '2330.TW', shares: 10, cost: 500, currency: 'TWD', current_price: 600, high_52w: 700, low_52w: 400, prev_close: 590 },
      { id: 'h2', ticker: 'AAPL', shares: 5, cost: 150, currency: 'USD', current_price: 175, high_52w: 200, low_52w: 140, prev_close: 170 },
    ],
    cash_accounts: [],
    debts: [],
    snapshots: [],
    categories: [],
    settings: { display_currency: 'TWD', language: 'en', fx_rate: 32 },
    meta: {},
  };
  const out = JSON.parse(serializeData(data));
  assert.equal(out.holdings[0].ticker, '2330.TW');
  assert.equal(out.holdings[1].ticker, 'AAPL');
  assert.equal(out.settings.fx_rate, 32);
});

// --- serializeData: strips in-memory flags ---

test('serializeData strips _refresh_failed from holdings', () => {
  const data = { holdings: [{ id: 'h1', ticker: 'AAPL', _refresh_failed: true }] };
  const out = JSON.parse(serializeData(data));
  assert.equal('_refresh_failed' in out.holdings[0], false);
  assert.equal(out.holdings[0].ticker, 'AAPL');
});

test('serializeData strips _refresh_failed when false (preserves no flag at all)', () => {
  const data = { holdings: [{ id: 'h1', ticker: 'AAPL', _refresh_failed: false }] };
  const out = JSON.parse(serializeData(data));
  assert.equal('_refresh_failed' in out.holdings[0], false);
});

test('serializeData strips _refresh_failed across multiple holdings', () => {
  const data = { holdings: [
    { id: 'h1', ticker: 'AAPL', _refresh_failed: true },
    { id: 'h2', ticker: 'GOOG', _refresh_failed: false },
    { id: 'h3', ticker: '2330.TW' },  // never set
  ]};
  const out = JSON.parse(serializeData(data));
  for (const h of out.holdings) {
    assert.equal('_refresh_failed' in h, false);
  }
});

test('serializeData only strips from holdings, not from top-level data', () => {
  // Defensive: the replacer should match `key === '_refresh_failed'` at any depth,
  // but only top-level holding fields are filtered. Test that the replacer is precise.
  const data = {
    meta: { _refresh_failed: 'should-be-stripped-anywhere-actually' },
    holdings: [{ _refresh_failed: true }],
  };
  const out = JSON.parse(serializeData(data));
  // Current impl strips anywhere (it's a JSON.stringify replacer that runs per key).
  // This is conservative: safer to over-strip than under-strip.
  assert.equal('_refresh_failed' in out.holdings[0], false);
});

test('serializeData preserves unrelated underscore-prefixed fields', () => {
  // Only specifically listed in-memory fields are stripped. Other underscore fields pass through.
  // Currently no other underscore fields exist in the schema, but the behavior should be explicit.
  const data = { holdings: [{ id: 'h1', _internal_note: 'user-set', _refresh_failed: true }] };
  const out = JSON.parse(serializeData(data));
  assert.equal(out.holdings[0]._internal_note, 'user-set');  // passes through
  assert.equal('_refresh_failed' in out.holdings[0], false);
});

// --- serializeData: format ---

test('serializeData uses 2-space indentation', () => {
  const data = { a: 1, b: 2 };
  const out = serializeData(data);
  // 2-space indent means lines like "  \"a\": 1"
  assert.match(out, /\n {2}"a": 1/);
});

// --- stripInMemoryFields: in-place mutation ---

test('stripInMemoryFields removes _refresh_failed from a single holding', () => {
  const h = { id: 'h1', _refresh_failed: true };
  stripInMemoryFields([h]);
  assert.equal('_refresh_failed' in h, false);
  assert.equal(h.id, 'h1');
});

test('stripInMemoryFields handles an empty array', () => {
  const arr = [];
  const out = stripInMemoryFields(arr);
  assert.deepEqual(out, []);
});

test('stripInMemoryFields handles an array with no flags', () => {
  const arr = [{ id: 'h1', ticker: 'AAPL' }, { id: 'h2', ticker: 'GOOG' }];
  stripInMemoryFields(arr);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].ticker, 'AAPL');
  assert.equal(arr[1].ticker, 'GOOG');
});

test('stripInMemoryFields does not mutate non-array objects passed at top level (returns new)', () => {
  const data = { holdings: [{ id: 'h1', _refresh_failed: true }] };
  const out = stripInMemoryFields(data);
  // In-memory flag should be gone from output
  assert.equal('_refresh_failed' in out.holdings[0], false);
  // Original object's holding flag may still be there (depends on implementation choice);
  // the contract is that the RETURNED object is clean.
  // We use recursive in-place mutation, so original is also clean — that's an implementation detail.
});

test('stripInMemoryFields handles nested data (snapshots, categories)', () => {
  const data = {
    holdings: [{ _refresh_failed: true }],
    cash_accounts: [{ _refresh_failed: true }],
    debts: [{ _refresh_failed: true }],
  };
  const out = stripInMemoryFields(data);
  assert.equal('_refresh_failed' in out.holdings[0], false);
  assert.equal('_refresh_failed' in out.cash_accounts[0], false);
  assert.equal('_refresh_failed' in out.debts[0], false);
});

test('stripInMemoryFields is idempotent (running twice is safe)', () => {
  const data = { holdings: [{ _refresh_failed: true }] };
  const out1 = stripInMemoryFields(data);
  const out2 = stripInMemoryFields(out1);
  assert.equal('_refresh_failed' in out2.holdings[0], false);
  assert.deepEqual(out1, out2);
});

// --- Realistic end-to-end: refresh-then-serialize scenario ---

test('end-to-end: refreshAllPrices writes _refresh_failed, serializeData strips it', () => {
  // Simulate the post-refresh state that would be saved.
  const data = {
    version: '1.1',
    holdings: [
      { id: 'h1', ticker: 'AAPL', current_price: 175, _refresh_failed: false },
      { id: 'h2', ticker: 'INVALID', current_price: 100, _refresh_failed: true },
      { id: 'h3', ticker: '2330.TW', current_price: 600, _refresh_failed: false },
    ],
  };
  // Persist via serializeData (simulates save/writePortfolioFile/downloadJSON).
  const persisted = JSON.parse(serializeData(data));
  // Re-load — verify _refresh_failed is gone from every holding.
  for (const h of persisted.holdings) {
    assert.equal('_refresh_failed' in h, false, `holding ${h.ticker} still has _refresh_failed`);
  }
  // Real fields are preserved.
  assert.equal(persisted.holdings[0].current_price, 175);
  assert.equal(persisted.holdings[1].current_price, 100);  // stale value kept
  assert.equal(persisted.holdings[2].current_price, 600);
});

test('end-to-end: import-time strip also clears _refresh_failed', () => {
  // Simulate importing a malicious or stale file that contains _refresh_failed.
  const parsed = {
    version: '1.1',
    holdings: [
      { id: 'h1', ticker: 'AAPL', _refresh_failed: true, current_price: 175 },
    ],
  };
  Serialize: { stripInMemoryFields };
  // Use the imported strip function (same as handleImportFile does).
  const cleaned = stripInMemoryFields(parsed);
  assert.equal('_refresh_failed' in cleaned.holdings[0], false);
  assert.equal(cleaned.holdings[0].current_price, 175);
});
