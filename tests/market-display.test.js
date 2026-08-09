// tests/market-display.test.js — tests for lib/market-display.js (v1.1)
//
// Covers: dayDeltaLabel(), dayDeltaClass(), week52Style()
// Source of truth: lib/market-display.js + spec.md §4.2-§4.3.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dayDeltaLabel, dayDeltaClass, week52Style } = require('../lib/market-display.js');

// --- dayDeltaLabel ---

test('dayDeltaLabel: positive change → "+X.XX%"', () => {
  // 100 → 110: +10%
  assert.equal(dayDeltaLabel({ current_price: 110, prev_close: 100 }), '+10.00%');
});

test('dayDeltaLabel: negative change → "-X.XX%"', () => {
  // 100 → 90: -10%
  assert.equal(dayDeltaLabel({ current_price: 90, prev_close: 100 }), '-10.00%');
});

test('dayDeltaLabel: zero change → "0.00%" (no plus sign)', () => {
  assert.equal(dayDeltaLabel({ current_price: 100, prev_close: 100 }), '0.00%');
});

test('dayDeltaLabel: small positive → "+0.01%" (preserves sign)', () => {
  // 100 → 100.01: +0.01%
  assert.equal(dayDeltaLabel({ current_price: 100.01, prev_close: 100 }), '+0.01%');
});

test('dayDeltaLabel: large negative → "-99.99%"', () => {
  // 100 → 0.01: -99.99%
  assert.equal(dayDeltaLabel({ current_price: 0.01, prev_close: 100 }), '-99.99%');
});

test('dayDeltaLabel: prev_close null → "—"', () => {
  assert.equal(dayDeltaLabel({ current_price: 100, prev_close: null }), '—');
});

test('dayDeltaLabel: prev_close undefined → "—"', () => {
  assert.equal(dayDeltaLabel({ current_price: 100 }), '—');
});

test('dayDeltaLabel: prev_close zero → "—" (avoid division by zero)', () => {
  assert.equal(dayDeltaLabel({ current_price: 100, prev_close: 0 }), '—');
});

test('dayDeltaLabel: 2-decimal precision', () => {
  // 100 → 105.6789: 5.6789% → "+5.68%"
  assert.equal(dayDeltaLabel({ current_price: 105.6789, prev_close: 100 }), '+5.68%');
});

test('dayDeltaLabel: rounding half-to-even handled by toFixed', () => {
  // 1/3 = 33.333...% → "+33.33%"
  assert.equal(dayDeltaLabel({ current_price: 100/3 * 1.01 + 100, prev_close: 100 }).startsWith('+33.'), true);
});

test('dayDeltaLabel: sign on negative values', () => {
  // toFixed(-0.05).toFixed(2) = "-0.05"
  assert.equal(dayDeltaLabel({ current_price: 99.95, prev_close: 100 }), '-0.05%');
});

// --- dayDeltaClass ---

test('dayDeltaClass: positive → text-emerald-600', () => {
  assert.equal(dayDeltaClass({ current_price: 110, prev_close: 100 }), 'text-emerald-600');
});

test('dayDeltaClass: negative → text-rose-600', () => {
  assert.equal(dayDeltaClass({ current_price: 90, prev_close: 100 }), 'text-rose-600');
});

test('dayDeltaClass: zero → text-slate-400 (neutral)', () => {
  assert.equal(dayDeltaClass({ current_price: 100, prev_close: 100 }), 'text-slate-400');
});

test('dayDeltaClass: null prev_close → text-slate-400', () => {
  assert.equal(dayDeltaClass({ current_price: 100, prev_close: null }), 'text-slate-400');
});

test('dayDeltaClass: zero prev_close → text-slate-400 (no division by zero)', () => {
  assert.equal(dayDeltaClass({ current_price: 100, prev_close: 0 }), 'text-slate-400');
});

test('dayDeltaClass: tiny positive (0.001%) → emerald', () => {
  // 100 → 100.001: 0.001% > 0 → positive
  assert.equal(dayDeltaClass({ current_price: 100.001, prev_close: 100 }), 'text-emerald-600');
});

test('dayDeltaClass: tiny negative (-0.001%) → rose', () => {
  // 100 → 99.999: -0.001% < 0 → negative
  assert.equal(dayDeltaClass({ current_price: 99.999, prev_close: 100 }), 'text-rose-600');
});

// --- week52Style ---

test('week52Style: middle of range → "left: 50%"', () => {
  // range 100-200, current 150 → 50%
  assert.equal(week52Style({ current_price: 150, low_52w: 100, high_52w: 200 }), 'left: 50%');
});

test('week52Style: at low → "left: 0%"', () => {
  assert.equal(week52Style({ current_price: 100, low_52w: 100, high_52w: 200 }), 'left: 0%');
});

test('week52Style: at high → "left: 100%"', () => {
  assert.equal(week52Style({ current_price: 200, low_52w: 100, high_52w: 200 }), 'left: 100%');
});

test('week52Style: above high → clamps to 100%', () => {
  // 100-200, current 250 → clamp to 100%
  assert.equal(week52Style({ current_price: 250, low_52w: 100, high_52w: 200 }), 'left: 100%');
});

test('week52Style: below low → clamps to 0%', () => {
  // 100-200, current 50 → clamp to 0%
  assert.equal(week52Style({ current_price: 50, low_52w: 100, high_52w: 200 }), 'left: 0%');
});

test('week52Style: low === high → centers at 50%', () => {
  // range 0, current = low = high = 100 → 50%
  assert.equal(week52Style({ current_price: 100, low_52w: 100, high_52w: 100 }), 'left: 50%');
});

test('week52Style: low null → null (no bar)', () => {
  assert.equal(week52Style({ current_price: 100, low_52w: null, high_52w: 200 }), null);
});

test('week52Style: high null → null (no bar)', () => {
  assert.equal(week52Style({ current_price: 100, low_52w: 100, high_52w: null }), null);
});

test('week52Style: both null → null', () => {
  assert.equal(week52Style({ current_price: 100, low_52w: null, high_52w: null }), null);
});

test('week52Style: low undefined → null', () => {
  assert.equal(week52Style({ current_price: 100, high_52w: 200 }), null);
});

test('week52Style: 25% of range → "left: 25%"', () => {
  // 100-200, current 125 → 25%
  assert.equal(week52Style({ current_price: 125, low_52w: 100, high_52w: 200 }), 'left: 25%');
});

test('week52Style: 75% of range → "left: 75%"', () => {
  // 100-200, current 175 → 75%
  assert.equal(week52Style({ current_price: 175, low_52w: 100, high_52w: 200 }), 'left: 75%');
});

test('week52Style: floating-point computation', () => {
  // 99.5-100.5, current 100.0 → 50%
  assert.equal(week52Style({ current_price: 100, low_52w: 99.5, high_52w: 100.5 }), 'left: 50%');
});

// --- Integration: same input produces consistent label + class ---

test('integration: positive price change shows green "+X.XX%"', () => {
  const h = { current_price: 110, prev_close: 100 };
  assert.equal(dayDeltaLabel(h), '+10.00%');
  assert.equal(dayDeltaClass(h), 'text-emerald-600');
});

test('integration: null prev_close shows gray "—"', () => {
  const h = { current_price: 110, prev_close: null };
  assert.equal(dayDeltaLabel(h), '—');
  assert.equal(dayDeltaClass(h), 'text-slate-400');
});