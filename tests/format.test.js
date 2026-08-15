// tests/format.test.js — automated tests for lib/format.js
//
// Run with:
//   node --test tests/format.test.js
// Or:
//   ./test.sh
//
// Spec source of truth: issue #10, CONTEXT.md "Compact suffix".
// FX rate matches the example in the user's original request:
//   150,000 TWD / 31 = $4,838.71 USD.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatAmount, toTWD, fromTWD } = require('../lib/format.js');

const FX = 31; // USD → TWD rate used by tests

// ----- TWD display -----

test('TWD display: W format (10K ≤ abs < 100M)', () => {
  assert.strictEqual(formatAmount(150_000, 'TWD', 'TWD', FX), '$15.00W');
  assert.strictEqual(formatAmount(15_000, 'TWD', 'TWD', FX), '$1.50W');
  assert.strictEqual(formatAmount(10_000, 'TWD', 'TWD', FX), '$1.00W');
  assert.strictEqual(formatAmount(99_999_999, 'TWD', 'TWD', FX), '$10,000.00W');
});

test('TWD display: W format with negative', () => {
  assert.strictEqual(formatAmount(-15_000, 'TWD', 'TWD', FX), '-$1.50W');
  assert.strictEqual(formatAmount(-99_999_999, 'TWD', 'TWD', FX), '-$10,000.00W');
});

test('TWD display: Y format (abs ≥ 100M)', () => {
  assert.strictEqual(formatAmount(100_000_000, 'TWD', 'TWD', FX), '$1.00Y');
  assert.strictEqual(formatAmount(150_000_000, 'TWD', 'TWD', FX), '$1.50Y');
  assert.strictEqual(formatAmount(-150_000_000, 'TWD', 'TWD', FX), '-$1.50Y');
});

test('TWD display: full format (abs < 10K)', () => {
  assert.strictEqual(formatAmount(9_999, 'TWD', 'TWD', FX), '$9,999.00');
  assert.strictEqual(formatAmount(5_000, 'TWD', 'TWD', FX), '$5,000.00');
  assert.strictEqual(formatAmount(1_265.86, 'TWD', 'TWD', FX), '$1,265.86');
  assert.strictEqual(formatAmount(1, 'TWD', 'TWD', FX), '$1.00');
  assert.strictEqual(formatAmount(0, 'TWD', 'TWD', FX), '$0.00');
});

// ----- USD display -----

test('USD display: K format (1K ≤ abs < 1M)', () => {
  assert.strictEqual(formatAmount(1_500, 'USD', 'USD', FX), '$1.50K');
  assert.strictEqual(formatAmount(1_000, 'USD', 'USD', FX), '$1.00K');
  assert.strictEqual(formatAmount(999_999, 'USD', 'USD', FX), '$1,000.00K');
});

test('USD display: K format with negative', () => {
  assert.strictEqual(formatAmount(-1_500, 'USD', 'USD', FX), '-$1.50K');
  assert.strictEqual(formatAmount(-999_999, 'USD', 'USD', FX), '-$1,000.00K');
});

test('USD display: M format (abs ≥ 1M)', () => {
  assert.strictEqual(formatAmount(1_000_000, 'USD', 'USD', FX), '$1.00M');
  assert.strictEqual(formatAmount(1_500_000, 'USD', 'USD', FX), '$1.50M');
  assert.strictEqual(formatAmount(5_000_000, 'USD', 'USD', FX), '$5.00M');
  assert.strictEqual(formatAmount(-1_500_000, 'USD', 'USD', FX), '-$1.50M');
});

test('USD display: full format (abs < 1K)', () => {
  assert.strictEqual(formatAmount(999, 'USD', 'USD', FX), '$999.00');
  assert.strictEqual(formatAmount(500, 'USD', 'USD', FX), '$500.00');
  assert.strictEqual(formatAmount(1, 'USD', 'USD', FX), '$1.00');
  assert.strictEqual(formatAmount(0, 'USD', 'USD', FX), '$0.00');
});

// ----- Cross-currency conversion -----

test('Cross: TWD source → USD display', () => {
  // 150,000 TWD / 31 = $4,838.71 USD → ≥ $1K → K format
  assert.strictEqual(formatAmount(150_000, 'TWD', 'USD', FX), '$4.84K');
  // 15,000 TWD / 31 = $483.87 USD → < $1K → full
  assert.strictEqual(formatAmount(15_000, 'TWD', 'USD', FX), '$483.87');
  // 1,000,000 TWD / 31 = $32,258.06 USD → K format
  assert.strictEqual(formatAmount(1_000_000, 'TWD', 'USD', FX), '$32.26K');
});

test('Cross: USD source → TWD display', () => {
  // 500 USD * 31 = 15,500 TWD → ≥ 10K → W
  assert.strictEqual(formatAmount(500, 'USD', 'TWD', FX), '$1.55W');
  // 1,000 USD * 31 = 31,000 TWD → ≥ 10K → W
  assert.strictEqual(formatAmount(1_000, 'USD', 'TWD', FX), '$3.10W');
  // 5,000,000 USD * 31 = 155,000,000 TWD → ≥ 100M → Y
  assert.strictEqual(formatAmount(5_000_000, 'USD', 'TWD', FX), '$1.55Y');
  // 100 USD * 31 = 3,100 TWD → < 10K → full
  assert.strictEqual(formatAmount(100, 'USD', 'TWD', FX), '$3,100.00');
  // -1,000 USD * 31 = -31,000 TWD → negative W
  assert.strictEqual(formatAmount(-1_000, 'USD', 'TWD', FX), '-$3.10W');
});

// ----- Threshold boundary inclusivity -----

test('Thresholds use >= (inclusive)', () => {
  // TWD: exactly 10,000 → W
  assert.strictEqual(formatAmount(10_000, 'TWD', 'TWD', FX), '$1.00W');
  // TWD: exactly 9,999 → full
  assert.strictEqual(formatAmount(9_999, 'TWD', 'TWD', FX), '$9,999.00');
  // TWD: exactly 100,000,000 → Y
  assert.strictEqual(formatAmount(100_000_000, 'TWD', 'TWD', FX), '$1.00Y');
  // TWD: 100,000,000 - 1 → W
  assert.strictEqual(formatAmount(99_999_999, 'TWD', 'TWD', FX), '$10,000.00W');
  // USD: exactly 1,000 → K
  assert.strictEqual(formatAmount(1_000, 'USD', 'USD', FX), '$1.00K');
  // USD: exactly 999 → full
  assert.strictEqual(formatAmount(999, 'USD', 'USD', FX), '$999.00');
  // USD: exactly 1,000,000 → M
  assert.strictEqual(formatAmount(1_000_000, 'USD', 'USD', FX), '$1.00M');
});

// ----- FX rate effect -----

test('FX rate changes conversion result', () => {
  // FX = 32: 1,000 USD → 32,000 TWD → $3.20W
  assert.strictEqual(formatAmount(1_000, 'USD', 'TWD', 32), '$3.20W');
  // FX = 31: 1,000 USD → 31,000 TWD → $3.10W
  assert.strictEqual(formatAmount(1_000, 'USD', 'TWD', 31), '$3.10W');
  // FX = 32: 1,000 USD → $1,000.00 USD (no conversion when source === display)
  assert.strictEqual(formatAmount(1_000, 'USD', 'USD', 32), '$1.00K');
});

// ----- Helpers -----

test('toTWD: TWD identity, USD * fxRate, unknown passthrough', () => {
  assert.strictEqual(toTWD(100, 'TWD', 31), 100);
  assert.strictEqual(toTWD(100, 'USD', 31), 3_100);
  assert.strictEqual(toTWD(100, 'XYZ', 31), 100);
});

test('fromTWD: TWD identity, USD / fxRate, unknown passthrough', () => {
  assert.strictEqual(fromTWD(3_100, 'TWD', 31), 3_100);
  assert.strictEqual(fromTWD(3_100, 'USD', 31), 100);
  assert.strictEqual(fromTWD(100, 'XYZ', 31), 100);
});

test('Round-trip TWD → USD → TWD is identity', () => {
  const amount = 12_345.67;
  const usd = fromTWD(toTWD(amount, 'TWD', FX), 'USD', FX);
  const twd = fromTWD(toTWD(usd, 'USD', FX), 'TWD', FX);
  assert.ok(Math.abs(twd - amount) < 1e-9, `expected ${amount}, got ${twd}`);
});
// ---------------------------------------------------------------------------
// v1.5 ticket 04 — deltaPercent helper
// (see .scratch/v1.5-snapshot-ui/issues/04-compare-two-snapshots.md)
// ---------------------------------------------------------------------------
// Rules (Q2 = A):
//   - denom === 0 OR non-finite numerator → '—' (honest signal, no fake ∞)
//   - sign matches num: '+X.X%' when num ≥ 0, '-X.X%' when num < 0
//   - 1 decimal place

const { deltaPercent } = require('../lib/format.js');

test('deltaPercent: positive delta with non-zero denom → "+X.X%"', () => {
  assert.equal(deltaPercent(5, 100), '+5.0%');
  assert.equal(deltaPercent(123456, 2370000), '+5.2%');
});

test('deltaPercent: negative delta → "-X.X%"', () => {
  assert.equal(deltaPercent(-5, 100), '-5.0%');
  assert.equal(deltaPercent(-50, 100), '-50.0%');
});

test('deltaPercent: zero delta → "+0.0%"', () => {
  assert.equal(deltaPercent(0, 100), '+0.0%');
});

test('deltaPercent: denom === 0 → "—" (honest signal)', () => {
  assert.equal(deltaPercent(5, 0), '—');
  assert.equal(deltaPercent(0, 0), '—');
  assert.equal(deltaPercent(-5, 0), '—');
});

test('deltaPercent: non-finite numerator → "—"', () => {
  assert.equal(deltaPercent(NaN, 100), '—');
  assert.equal(deltaPercent(Infinity, 100), '—');
  assert.equal(deltaPercent(-Infinity, 100), '—');
});

test('deltaPercent: non-finite denominator → "—"', () => {
  assert.equal(deltaPercent(5, NaN), '—');
  assert.equal(deltaPercent(5, Infinity), '—');
});
