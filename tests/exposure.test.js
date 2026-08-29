// tests/exposure.test.js — tests for lib/exposure.js (v1.21)
//
// Covers: parseMultiplier, ensureDefaultCategories,
// findDefaultExposureCategory, exposureMultiplier, exposureBreakdown.
// Source of truth: lib/exposure.js +
//   .scratch/v1.21-home-exposure-card/issues/01-lib-exposure-helpers.md
//
// Behaviour pinned here is the contract for the v1.21 Home Exposure
// card and the load-time lazy-add of the Default Exposure category.
// FX conversion comes from lib/format.js toTWD — we pass fxRate
// explicitly so tests don't need a browser.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMultiplier,
  ensureDefaultCategories,
  findDefaultExposureCategory,
  exposureMultiplier,
  exposureBreakdown,
  DEFAULT_EXPOSURE_CATEGORY_ID,
} = require('../lib/exposure.js');

// ---- Fixtures ----

// 1 USD = 32 TWD.
const FX = 32;

// Helper to make a fresh default-exposure category shape. Mirrors the
// seeded shape in lib/exposure.js (without timestamp/deviceId) so each
// test starts from a known baseline.
function makeDefaultCat(overrides = {}) {
  return {
    id: DEFAULT_EXPOSURE_CATEGORY_ID,
    name: 'Exposure',
    isDefault: true,
    applies_to: ['holdings', 'cash'],
    values: [
      { id: 'val-default-0x', name: '0x' },
      { id: 'val-default-1x', name: '1x' },
      { id: 'val-default-2x', name: '2x' },
    ],
    ...overrides,
  };
}

// ============================================================================
// parseMultiplier
// ============================================================================

test('parseMultiplier: numeric string with x suffix', () => {
  assert.equal(parseMultiplier('0x'), 0);
  assert.equal(parseMultiplier('1x'), 1);
  assert.equal(parseMultiplier('2x'), 2);
});

test('parseMultiplier: fractional values', () => {
  assert.equal(parseMultiplier('1.5x'), 1.5);
  assert.equal(parseMultiplier('0.5x'), 0.5);
  assert.equal(parseMultiplier('2.25x'), 2.25);
});

test('parseMultiplier: x suffix is optional', () => {
  assert.equal(parseMultiplier('2'), 2);
  assert.equal(parseMultiplier('0.5'), 0.5);
});

test('parseMultiplier: case-insensitive', () => {
  assert.equal(parseMultiplier('2X'), 2);
  assert.equal(parseMultiplier('1.5X'), 1.5);
});

test('parseMultiplier: surrounding whitespace tolerated', () => {
  assert.equal(parseMultiplier(' 2x '), 2);
  assert.equal(parseMultiplier('2x '), 2);
});

test('parseMultiplier: empty string → 1 (default)', () => {
  assert.equal(parseMultiplier(''), 1);
});

test('parseMultiplier: garbage string → 1 (default)', () => {
  assert.equal(parseMultiplier('foo'), 1);
  assert.equal(parseMultiplier('2xx'), 1);
  assert.equal(parseMultiplier('x2'), 1);
  assert.equal(parseMultiplier('2.5.5x'), 1);
});

test('parseMultiplier: negative value → 1 (rejected)', () => {
  assert.equal(parseMultiplier('-1x'), 1);
  assert.equal(parseMultiplier('-0.5x'), 1);
});

test('parseMultiplier: null/undefined/non-string → 1 (default)', () => {
  assert.equal(parseMultiplier(null), 1);
  assert.equal(parseMultiplier(undefined), 1);
  assert.equal(parseMultiplier(2), 1);
  assert.equal(parseMultiplier({}), 1);
});

// ============================================================================
// ensureDefaultCategories
// ============================================================================

test('ensureDefaultCategories: empty categories → seeded with 0x, 1x, 2x', () => {
  const data = { categories: [] };
  const out = ensureDefaultCategories(data);
  assert.equal(out.categories.length, 1);
  const seeded = out.categories[0];
  assert.equal(seeded.id, DEFAULT_EXPOSURE_CATEGORY_ID);
  assert.equal(seeded.isDefault, true);
  assert.deepEqual(seeded.applies_to, ['holdings', 'cash']);
  assert.deepEqual(
    seeded.values.map(v => v.name).sort(),
    ['0x', '1x', '2x']
  );
  // Value ids should be stable / predictable so attribute refs survive sync.
  assert.equal(seeded.values.find(v => v.name === '0x').id, 'val-default-0x');
  assert.equal(seeded.values.find(v => v.name === '1x').id, 'val-default-1x');
  assert.equal(seeded.values.find(v => v.name === '2x').id, 'val-default-2x');
});

test('ensureDefaultCategories: already has Default Exposure → no-op (returns same data ref)', () => {
  const existing = makeDefaultCat();
  const data = { categories: [existing] };
  const out = ensureDefaultCategories(data);
  // Same reference — the function must not allocate a new array.
  assert.equal(out, data);
  assert.equal(out.categories.length, 1);
  assert.equal(out.categories[0], existing);
});

test('ensureDefaultCategories: existing Default Exposure has user-added values → preserved untouched', () => {
  const existing = makeDefaultCat({
    values: [
      { id: 'val-default-0x', name: '0x' },
      { id: 'val-default-1x', name: '1x' },
      { id: 'val-default-2x', name: '2x' },
      { id: 'val-default-3x', name: '3x' }, // user-added
    ],
  });
  const data = { categories: [existing] };
  const out = ensureDefaultCategories(data);
  assert.equal(out, data);
  assert.equal(out.categories[0].values.length, 4, 'user-added 3x preserved');
  assert.equal(out.categories[0].values[3].name, '3x');
});

test('ensureDefaultCategories: another isDefault category but not Exposure → adds Exposure alongside', () => {
  // Defensive: only seed 'cat-default-exposure', not generic isDefault.
  const otherDefault = {
    id: 'cat-default-other',
    name: 'Other',
    isDefault: true,
    applies_to: ['holdings'],
    values: [],
  };
  const data = { categories: [otherDefault] };
  const out = ensureDefaultCategories(data);
  assert.equal(out.categories.length, 2);
  assert.equal(out.categories[0], otherDefault, 'original preserved');
  assert.equal(out.categories[1].id, DEFAULT_EXPOSURE_CATEGORY_ID);
});

test('ensureDefaultCategories: missing data.categories → no-op', () => {
  // Defensive: malformed data shouldn't crash the load flow.
  assert.equal(ensureDefaultCategories(null), null);
  assert.equal(ensureDefaultCategories(undefined), undefined);
  const noCat = ensureDefaultCategories({});
  assert.equal(noCat.categories, undefined);
});

test('ensureDefaultCategories: categories is not an array → returned unchanged', () => {
  const data = { categories: 'not-an-array' };
  assert.equal(ensureDefaultCategories(data), data);
});

test('ensureDefaultCategories: seeded category carries updated_at + device_id', () => {
  const data = { categories: [] };
  const out = ensureDefaultCategories(data);
  const seeded = out.categories[0];
  assert.equal(typeof seeded.updated_at, 'string');
  assert.ok(seeded.updated_at.length > 0, 'updated_at must be a non-empty ISO string');
  // DEVICE_ID is undefined under node:test → device_id is 'unknown'.
  // The spec wires this through the browser global DEVICE_ID at runtime.
  assert.ok(typeof seeded.device_id === 'string', 'device_id must be a string');
});

// ============================================================================
// findDefaultExposureCategory
// ============================================================================

test('findDefaultExposureCategory: present → returns the category', () => {
  const cat = makeDefaultCat();
  const out = findDefaultExposureCategory([cat, { id: 'other', name: 'Other' }]);
  assert.equal(out, cat);
});

test('findDefaultExposureCategory: missing → null', () => {
  assert.equal(findDefaultExposureCategory([]), null);
  assert.equal(findDefaultExposureCategory([{ id: 'other', name: 'Other' }]), null);
});

test('findDefaultExposureCategory: same id but not isDefault → null (defensive)', () => {
  const fake = {
    id: DEFAULT_EXPOSURE_CATEGORY_ID,
    name: 'Exposure',
    isDefault: false,
    values: [],
  };
  assert.equal(findDefaultExposureCategory([fake]), null);
});

test('findDefaultExposureCategory: isDefault true but different id → null (defensive)', () => {
  const fake = {
    id: 'cat-default-other',
    name: 'Other',
    isDefault: true,
    values: [],
  };
  assert.equal(findDefaultExposureCategory([fake]), null);
});

test('findDefaultExposureCategory: non-array input → null', () => {
  assert.equal(findDefaultExposureCategory(null), null);
  assert.equal(findDefaultExposureCategory(undefined), null);
  assert.equal(findDefaultExposureCategory('garbage'), null);
});

// ============================================================================
// exposureBreakdown
// ============================================================================

test('exposureBreakdown: null defaultExposureCategory → []', () => {
  const out = exposureBreakdown([], [], null, FX);
  assert.deepEqual(out, []);
});

test('exposureBreakdown: defaultCategory with no values + no records → []', () => {
  const cat = { id: DEFAULT_EXPOSURE_CATEGORY_ID, values: [] };
  assert.deepEqual(exposureBreakdown([], [], cat, FX), []);
});

test('exposureBreakdown: 0 records → []', () => {
  const cat = makeDefaultCat();
  assert.deepEqual(exposureBreakdown([], [], cat, FX), []);
});

test('exposureBreakdown: single holding, no exposure attribute → Unassigned bucket', () => {
  const cat = makeDefaultCat();
  const holdings = [{ shares: 10, current_price: 100, currency: 'TWD', attributes: {} }];
  const out = exposureBreakdown(holdings, [], cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].valueId, '_unassigned');
  assert.equal(out[0].valueName, 'Unassigned');
  assert.equal(out[0].multiplier, 1);
  assert.equal(out[0].count, 1);
  assert.equal(out[0].totalTwd, 1000);
});

test('exposureBreakdown: holding tagged with 2x → bucket for 2x', () => {
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 10,
    current_price: 100,
    currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  const out = exposureBreakdown(holdings, [], cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].valueId, 'val-default-2x');
  assert.equal(out[0].valueName, '2x');
  assert.equal(out[0].multiplier, 2);
  assert.equal(out[0].count, 1);
  assert.equal(out[0].totalTwd, 1000);
});

test('exposureBreakdown: mixed holdings → sorted by multiplier desc, _unassigned last', () => {
  const cat = makeDefaultCat();
  const holdings = [
    { shares: 1, current_price: 100, currency: 'TWD', attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-0x' } },
    { shares: 1, current_price: 100, currency: 'TWD', attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' } },
    { shares: 1, current_price: 100, currency: 'TWD', attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' } },
    { shares: 1, current_price: 100, currency: 'TWD', attributes: {} }, // unassigned
  ];
  const out = exposureBreakdown(holdings, [], cat, FX);
  assert.equal(out.length, 4);
  assert.equal(out[0].valueId, 'val-default-2x', '2x first');
  assert.equal(out[1].valueId, 'val-default-1x', '1x second');
  assert.equal(out[2].valueId, 'val-default-0x', '0x third');
  assert.equal(out[3].valueId, '_unassigned', '_unassigned last');
});

test('exposureBreakdown: empty buckets (count === 0) are dropped', () => {
  const cat = makeDefaultCat();
  // Only 1x has any records; 0x and 2x should be omitted.
  const holdings = [{
    shares: 1, current_price: 100, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  const out = exposureBreakdown(holdings, [], cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].valueId, 'val-default-1x');
});

test('exposureBreakdown: holdings + cash accounts both contribute', () => {
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 1, current_price: 100, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  const cash = [{
    balance: 200, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  const out = exposureBreakdown(holdings, cash, cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].valueId, 'val-default-2x');
  assert.equal(out[0].count, 2);
  assert.equal(out[0].totalTwd, 300, '100 (holding) + 200 (cash)');
});

test('exposureBreakdown: inactive records are excluded', () => {
  const cat = makeDefaultCat();
  const holdings = [
    { shares: 1, current_price: 100, currency: 'TWD', inactive: true,
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' } },
    { shares: 1, current_price: 100, currency: 'TWD',
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' } },
  ];
  const out = exposureBreakdown(holdings, [], cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].valueId, 'val-default-1x');
  assert.equal(out[0].count, 1);
});

test('exposureBreakdown: multi-currency totals are converted to TWD', () => {
  const cat = makeDefaultCat();
  // USD $100 @ fxRate=32 → 3200 TWD
  const holdings = [{
    shares: 1, current_price: 100, currency: 'USD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  const cash = [{
    balance: 1000, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  const out = exposureBreakdown(holdings, cash, cat, FX);
  assert.equal(out.length, 1);
  assert.equal(out[0].totalTwd, 3200 + 1000);
});

// ============================================================================
// exposureMultiplier
// ============================================================================

test('exposureMultiplier: 0 holdings + 0 cash → null (no data)', () => {
  const cat = makeDefaultCat();
  assert.equal(exposureMultiplier([], [], cat, FX), null);
});

test('exposureMultiplier: all records Unassigned → 1', () => {
  const cat = makeDefaultCat();
  const holdings = [{ shares: 1, current_price: 100, currency: 'TWD', attributes: {} }];
  assert.equal(exposureMultiplier(holdings, [], cat, FX), 1);
});

test('exposureMultiplier: single holding tagged 2x → 2', () => {
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 1, current_price: 100, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  assert.equal(exposureMultiplier(holdings, [], cat, FX), 2);
});

test('exposureMultiplier: weighted average across 1x and 2x', () => {
  // $100 @ 1x + $100 @ 2x → (100×1 + 100×2) / 200 = 1.5
  const cat = makeDefaultCat();
  const holdings = [
    { shares: 1, current_price: 100, currency: 'TWD',
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' } },
    { shares: 1, current_price: 100, currency: 'TWD',
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' } },
  ];
  assert.equal(exposureMultiplier(holdings, [], cat, FX), 1.5);
});

test('exposureMultiplier: all 1x → 1', () => {
  const cat = makeDefaultCat();
  const holdings = [
    { shares: 1, current_price: 100, currency: 'TWD',
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' } },
    { shares: 2, current_price: 50, currency: 'TWD',
      attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' } },
  ];
  assert.equal(exposureMultiplier(holdings, [], cat, FX), 1);
});

test('exposureMultiplier: multi-currency, each 1x → 1', () => {
  // USD $100 (3200 TWD) + TWD $100 → both 1x → weighted = 1
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 1, current_price: 100, currency: 'USD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  const cash = [{
    balance: 100, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  assert.equal(exposureMultiplier(holdings, cash, cat, FX), 1);
});

test('exposureMultiplier: inactive holdings excluded', () => {
  // Only the inactive 2x holding exists → no active records → null.
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 1, current_price: 100, currency: 'TWD', inactive: true,
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  assert.equal(exposureMultiplier(holdings, [], cat, FX), null);
});

test('exposureMultiplier: holdings + cash weighted together', () => {
  // Holding $100 @ 2x (TWD $100) + Cash $200 @ 1x (TWD $200)
  // → (100×2 + 200×1) / 300 = 400/300 ≈ 1.333
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 1, current_price: 100, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  const cash = [{
    balance: 200, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  const out = exposureMultiplier(holdings, cash, cat, FX);
  assert.ok(Math.abs(out - 400 / 300) < 1e-9, `expected ≈ 1.333, got ${out}`);
});

test('exposureMultiplier: defaultCategory null → null', () => {
  // No category at all → we treat this as "no data" rather than crash.
  assert.equal(exposureMultiplier([], [], null, FX), null);
});

test('exposureMultiplier: zero-value active records → 0/0 → null (no data)', () => {
  // Spec: 1 holding 0 with 2x + 1 cash 0 with 1x → both have value 0,
  // sum is 0/0 → null (no data). Guards against a division-by-zero
  // crash when the user has tags but no TWD value to weight.
  const cat = makeDefaultCat();
  const holdings = [{
    shares: 0, current_price: 0, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-2x' },
  }];
  const cash = [{
    balance: 0, currency: 'TWD',
    attributes: { [DEFAULT_EXPOSURE_CATEGORY_ID]: 'val-default-1x' },
  }];
  assert.equal(exposureMultiplier(holdings, cash, cat, FX), null);
});
