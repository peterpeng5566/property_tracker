// tests/intraday.test.js — tests for lib/intraday.js (v1.1)
//
// Covers: INTRADAY_STATES, shouldWarnIntraday()
// Source of truth: lib/intraday.js + spec.md §6.2-§6.4.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { INTRADAY_STATES, shouldWarnIntraday } = require('../lib/intraday.js');

// --- INTRADAY_STATES ---

test('INTRADAY_STATES: contains PREPRE, PRE, REGULAR, POST, POSTPOST', () => {
  assert.ok(INTRADAY_STATES.has('PREPRE'));
  assert.ok(INTRADAY_STATES.has('PRE'));
  assert.ok(INTRADAY_STATES.has('REGULAR'));
  assert.ok(INTRADAY_STATES.has('POST'));
  assert.ok(INTRADAY_STATES.has('POSTPOST'));
});

test('INTRADAY_STATES: does NOT contain CLOSED, HALTED', () => {
  assert.ok(!INTRADAY_STATES.has('CLOSED'));
  assert.ok(!INTRADAY_STATES.has('HALTED'));
});

test('INTRADAY_STATES: total size 5', () => {
  assert.equal(INTRADAY_STATES.size, 5);
});

// --- shouldWarnIntraday: basic cases ---

test('shouldWarnIntraday: empty holdings → false', () => {
  assert.equal(shouldWarnIntraday([], {}), false);
});

test('shouldWarnIntraday: undefined holdings → false (defensive)', () => {
  assert.equal(shouldWarnIntraday(undefined, {}), false);
});

test('shouldWarnIntraday: null holdings → false (defensive)', () => {
  assert.equal(shouldWarnIntraday(null, {}), false);
});

test('shouldWarnIntraday: empty lastQuoteResults → false (no signal)', () => {
  // Matches manual verification Test 1: "No refresh ever run → lastQuoteResults empty"
  assert.equal(shouldWarnIntraday([{ ticker: 'AAPL' }], {}), false);
});

test('shouldWarnIntraday: null lastQuoteResults → false (defensive)', () => {
  assert.equal(shouldWarnIntraday([{ ticker: 'AAPL' }], null), false);
});

test('shouldWarnIntraday: undefined lastQuoteResults → false (defensive)', () => {
  assert.equal(shouldWarnIntraday([{ ticker: 'AAPL' }], undefined), false);
});

// --- shouldWarnIntraday: marketState checks ---

test('shouldWarnIntraday: all CLOSED → false', () => {
  // Matches Test 2
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }, { ticker: '2330.TW' }],
    { 'AAPL': { marketState: 'CLOSED' }, '2330.TW': { marketState: 'CLOSED' } }
  ), false);
});

test('shouldWarnIntraday: one REGULAR → true', () => {
  // Matches Test 3
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }, { ticker: '2330.TW' }],
    { 'AAPL': { marketState: 'REGULAR' }, '2330.TW': { marketState: 'CLOSED' } }
  ), true);
});

test('shouldWarnIntraday: PRE state → true', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'PRE' } }
  ), true);
});

test('shouldWarnIntraday: PREPRE state → true', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'PREPRE' } }
  ), true);
});

test('shouldWarnIntraday: POST state → true', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'POST' } }
  ), true);
});

test('shouldWarnIntraday: POSTPOST state → true', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'POSTPOST' } }
  ), true);
});

test('shouldWarnIntraday: HALTED state → false', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'HALTED' } }
  ), false);
});

test('shouldWarnIntraday: unknown marketState → false', () => {
  // Yahoo may add new states; treat unknown as not-intraday (defensive default)
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'FUTURE_UNKNOWN_STATE' } }
  ), false);
});

test('shouldWarnIntraday: holding with no lastQuoteResults entry → false', () => {
  // Ticker in holdings but not in lastQuoteResults (no fetch data)
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }, { ticker: 'MSFT' }],
    { 'AAPL': { marketState: 'CLOSED' } }  // MSFT not in results
  ), false);
});

// --- shouldWarnIntraday: FX exception (spec §6.4) ---

test('shouldWarnIntraday: FX holding REGULAR → false (FX exception)', () => {
  // Matches Test 4: "Holding with currency: 'FX' and marketState: 'REGULAR' → no dialog"
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'TWD=X', currency: 'FX' }],
    { 'TWD=X': { marketState: 'REGULAR' } }
  ), false);
});

test('shouldWarnIntraday: FX + stock mixed, stock is REGULAR → true', () => {
  // FX excluded, but stock still triggers
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'TWD=X', currency: 'FX' }, { ticker: 'AAPL' }],
    { 'TWD=X': { marketState: 'REGULAR' }, 'AAPL': { marketState: 'REGULAR' } }
  ), true);
});

test('shouldWarnIntraday: only FX holdings → false', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'TWD=X', currency: 'FX' }],
    { 'TWD=X': { marketState: 'REGULAR' } }
  ), false);
});

test('shouldWarnIntraday: holding without currency field defaults to non-FX', () => {
  // No currency === 'FX' check matches → treated as stock
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'REGULAR' } }
  ), true);
});

test('shouldWarnIntraday: currency TWD (not FX) → true when REGULAR', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: '2330.TW', currency: 'TWD' }],
    { '2330.TW': { marketState: 'REGULAR' } }
  ), true);
});

// --- shouldWarnIntraday: edge cases ---

test('shouldWarnIntraday: meta without marketState → false', () => {
  // Yahoo returns meta object but marketState is missing
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { regularMarketPrice: 150 } }
  ), false);
});

test('shouldWarnIntraday: meta marketState null → false', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: null } }
  ), false);
});

test('shouldWarnIntraday: meta marketState empty string → false', () => {
  assert.equal(shouldWarnIntraday(
    [{ ticker: 'AAPL' }],
    { 'AAPL': { marketState: '' } }
  ), false);
});

test('shouldWarnIntraday: null entry in holdings array → skipped', () => {
  // Defensive: handle corrupted data
  assert.equal(shouldWarnIntraday(
    [null, { ticker: 'AAPL' }],
    { 'AAPL': { marketState: 'CLOSED' } }
  ), false);
});

test('shouldWarnIntraday: short-circuits on first intraday match', () => {
  // Verify loop doesn't break when first match found
  const result = shouldWarnIntraday(
    [{ ticker: 'A' }, { ticker: 'B' }, { ticker: 'C' }],
    { 'A': { marketState: 'CLOSED' }, 'B': { marketState: 'REGULAR' }, 'C': { marketState: 'CLOSED' } }
  );
  assert.equal(result, true);
});

test('shouldWarnIntraday: non-object lastQuoteResults → false', () => {
  assert.equal(shouldWarnIntraday([{ ticker: 'A' }], 'not an object'), false);
  assert.equal(shouldWarnIntraday([{ ticker: 'A' }], 42), false);
});