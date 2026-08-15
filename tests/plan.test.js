// tests/plan.test.js — Unit tests for lib/plan.js (v1.4)
//
// Covers: validatePlan / validateRule / recordsMatchingRule /
// calcDistribution / driftForRule / driftForPlan / validatePlans /
// plansReferencingCategory / plansReferencingValue.
//
// Source of truth: lib/plan.js +
//   .scratch/v1.4-target-allocation-plans/issues/01-plan-data-model.md
//
// Records passed to the lib use a generic shape:
//   { id: string, currency: 'TWD' | 'USD', value: number }
// `value` is the per-record net-worth contribution in `currency`
// (holdings: shares * current_price, cash: balance, debts: -balance).
// The Alpine shim (portfolio.html) builds this generic shape from
// data.holdings / data.cash_accounts / data.debts; the lib is agnostic
// to record type.
//
// `recordsAttributes` is a parallel lookup { recordId → { catId → valueId } }
// so the lib can filter and group without knowing the holdings/cash/debts
// shape. The Alpine shim builds this once per drift computation.
//
// FX conversion goes through lib/format.js toTWD so the rule lives in
// one place. We pass fxRate explicitly so tests don't need a browser.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePlan,
  validateRule,
  recordsMatchingRule,
  calcDistribution,
  driftForRule,
  driftForPlan,
  validatePlans,
  plansReferencingCategory,
  plansReferencingValue,
  newPlan,
  newRule,
} = require('../lib/plan.js');

// ---- Fixtures ----

const FX = 32; // 1 USD = 32 TWD

// Categories used across tests.
const COUNTRY_CAT = {
  id: 'country',
  name: 'Country',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'TW', name: '台灣' },
    { id: 'US', name: 'United States' },
  ],
};
const TYPE_CAT = {
  id: 'type',
  name: 'Type',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'stock', name: 'Stock' },
    { id: 'bond', name: 'Bond' },
  ],
};
const ALL_CATEGORIES = [COUNTRY_CAT, TYPE_CAT];

// A well-formed single-rule plan used as a positive control.
function makeGoodPlan(overrides) {
  return Object.assign({
    id: 'plan-good',
    name: 'My Targets',
    rules: [
      {
        id: 'rule-1',
        when: { country: ['TW'] },
        distribute: { type: { stock: 60, bond: 40 } },
      },
    ],
  }, overrides || {});
}

// ---- newPlan / newRule ----

test('newPlan: returns an object with id, name, rules: []', () => {
  const p = newPlan('Test');
  assert.equal(typeof p.id, 'string');
  assert.ok(p.id.startsWith('plan-'));
  assert.equal(p.name, 'Test');
  assert.deepEqual(p.rules, []);
});

test('newRule: returns an object with id, when: {}, distribute: {}', () => {
  const r = newRule();
  assert.equal(typeof r.id, 'string');
  assert.ok(r.id.startsWith('rule-'));
  assert.deepEqual(r.when, {});
  assert.deepEqual(r.distribute, {});
});

test('newPlan / newRule: each call returns a distinct id', () => {
  const a = newPlan('A');
  const b = newPlan('A');
  assert.notEqual(a.id, b.id);
});

// ---- validateRule ----

test('validateRule: good rule with sum=100 → valid', () => {
  const r = { when: { country: ['TW'] }, distribute: { type: { stock: 60, bond: 40 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validateRule: weights sum != 100 → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 50, bond: 30 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /sum to 100/.test(e)));
});

test('validateRule: weights sum 99.99 accepted (FP epsilon)', () => {
  const r = { when: {}, distribute: { type: { stock: 59.99, bond: 40.01 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, true);
});

test('validateRule: weights sum 100.02 rejected', () => {
  const r = { when: {}, distribute: { type: { stock: 60.02, bond: 40 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /sum to 100/.test(e)));
});

test('validateRule: empty distribute (no key) → invalid', () => {
  const r = { when: {}, distribute: {} };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /exactly 1 key/.test(e)));
});

test('validateRule: multi-key distribute → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 100 }, country: { TW: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /exactly 1 key/.test(e)));
});

test('validateRule: empty when is allowed (matches all records)', () => {
  const r = { when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, true);
});

test('validateRule: when value is not an array → invalid', () => {
  const r = { when: { country: 'TW' }, distribute: { type: { stock: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /when\.country must be an array/.test(e)));
});

test('validateRule: when value is array of non-strings → invalid', () => {
  const r = { when: { country: [1, 2] }, distribute: { type: { stock: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /non-empty strings/.test(e)));
});

test('validateRule: when is an Array (not plain object) → invalid', () => {
  const r = { when: ['TW'], distribute: { type: { stock: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /when must be a plain object/.test(e)));
});

test('validateRule: missing distribute → invalid', () => {
  const r = { when: {} };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
});

test('validateRule: negative weight → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 110, bond: -10 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /non-negative finite number/.test(e)));
});

test('validateRule: non-numeric weight → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 'sixty', bond: 40 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, false);
});

test('validateRule: allCategories is accepted but does not gate validity (current behaviour)', () => {
  // The lib does not require the category ids referenced by when / distribute
  // to exist in allCategories. That check belongs in the UI layer (so the
  // user can save a plan referencing a category they just deleted) — see
  // plansReferencingCategory for the delete-protection path.
  const r = { when: { ghost: ['x'] }, distribute: { phantom: { y: 100 } } };
  const out = validateRule(r, ALL_CATEGORIES);
  assert.equal(out.valid, true);
});

// ---- validatePlan ----

test('validatePlan: good plan → valid', () => {
  const p = makeGoodPlan();
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validatePlan: empty name → invalid', () => {
  const p = makeGoodPlan({ name: '' });
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /non-empty string/.test(e)));
});

test('validatePlan: whitespace-only name → invalid', () => {
  const p = makeGoodPlan({ name: '   ' });
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, false);
});

test('validatePlan: duplicate name against other plan → invalid', () => {
  const p1 = makeGoodPlan({ id: 'plan-1', name: 'Growth' });
  const p2 = makeGoodPlan({ id: 'plan-2', name: 'Growth' });
  const out = validatePlan(p2, [p1, p2]);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /unique/.test(e)));
});

test('validatePlan: same name on the same plan (self) is OK', () => {
  const p = makeGoodPlan({ name: 'Growth' });
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, true);
});

test('validatePlan: zero rules → invalid', () => {
  const p = makeGoodPlan({ rules: [] });
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /at least 1 rule/.test(e)));
});

test('validatePlan: single bad rule → invalid (with rule-index prefix)', () => {
  const p = makeGoodPlan({
    rules: [
      { when: {}, distribute: { type: { stock: 50, bond: 30 } } }, // sum != 100
    ],
  });
  const out = validatePlan(p, [p]);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /Rule 1/.test(e)));
});

// ---- recordsMatchingRule ----

test('recordsMatchingRule: empty when matches all records', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
  ];
  const attrs = {};
  const rule = { when: {}, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.equal(out.length, 2);
});

test('recordsMatchingRule: single category single value', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
    { id: 'c', currency: 'TWD', value: 300 },
  ];
  const attrs = {
    a: { country: 'TW' },
    b: { country: 'US' },
    c: { country: 'TW' },
  };
  const rule = { when: { country: ['TW'] }, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id).sort(), ['a', 'c']);
});

test('recordsMatchingRule: single category multiple values (OR)', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
    { id: 'c', currency: 'TWD', value: 300 },
  ];
  const attrs = {
    a: { country: 'TW' },
    b: { country: 'US' },
    c: { country: 'JP' },
  };
  const rule = { when: { country: ['TW', 'JP'] }, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id).sort(), ['a', 'c']);
});

test('recordsMatchingRule: multi category (AND across categories)', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
    { id: 'c', currency: 'TWD', value: 300 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
    c: { country: 'US', type: 'stock' },
  };
  const rule = { when: { country: ['TW'], type: ['stock'] }, distribute: { country: { TW: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id), ['a']);
});

test('recordsMatchingRule: missing attribute → record skipped', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
  ];
  const attrs = {
    a: { country: 'TW' },
    b: { type: 'stock' }, // no country
  };
  const rule = { when: { country: ['TW'] }, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id), ['a']);
});

test('recordsMatchingRule: value id not in list → record skipped', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
  ];
  const attrs = {
    a: { country: 'TW' },
    b: { country: 'JP' },
  };
  const rule = { when: { country: ['TW'] }, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id), ['a']);
});

test('recordsMatchingRule: falls back to record.attributes when recordsAttributes is missing for that id', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100, attributes: { country: 'TW' } },
    { id: 'b', currency: 'TWD', value: 200, attributes: { country: 'US' } },
  ];
  const attrs = {}; // empty — lib should fall back to record.attributes
  const rule = { when: { country: ['TW'] }, distribute: { type: { stock: 100 } } };
  const out = recordsMatchingRule(rule, records, attrs);
  assert.deepEqual(out.map(r => r.id), ['a']);
});

test('recordsMatchingRule: null records → returns []', () => {
  const rule = { when: {}, distribute: { type: { stock: 100 } } };
  assert.deepEqual(recordsMatchingRule(rule, null, {}), []);
});

// ---- calcDistribution ----

test('calcDistribution: all records have attribute → totals in TWD', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
    { id: 'c', currency: 'TWD', value: 300 },
  ];
  const attrs = {
    a: { type: 'stock' },
    b: { type: 'stock' },
    c: { type: 'bond' },
  };
  const out = calcDistribution(records, 'type', attrs, FX);
  assert.equal(out.stock, 300);
  assert.equal(out.bond, 300);
});

test('calcDistribution: some records missing the target attribute → omit', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 200 },
  ];
  const attrs = {
    a: { type: 'stock' },
    b: { country: 'TW' }, // no `type`
  };
  const out = calcDistribution(records, 'type', attrs, FX);
  assert.deepEqual(out, { stock: 100 });
});

test('calcDistribution: all records missing → empty {}', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
  ];
  const attrs = {
    a: { country: 'TW' },
  };
  const out = calcDistribution(records, 'type', attrs, FX);
  assert.deepEqual(out, {});
});

test('calcDistribution: multi-currency records summed to TWD via toTWD', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 1000 },
    { id: 'b', currency: 'USD', value: 10 },     // 10 USD * 32 = 320 TWD
    { id: 'c', currency: 'USD', value: 5 },      // 5 USD * 32 = 160 TWD
  ];
  const attrs = {
    a: { type: 'stock' },
    b: { type: 'stock' },
    c: { type: 'bond' },
  };
  const out = calcDistribution(records, 'type', attrs, FX);
  assert.equal(out.stock, 1320);
  assert.equal(out.bond, 160);
});

test('calcDistribution: missing/non-numeric value treated as 0', () => {
  const records = [
    { id: 'a', currency: 'TWD' }, // no value
    { id: 'b', currency: 'TWD', value: 200 },
  ];
  const attrs = {
    a: { type: 'stock' },
    b: { type: 'bond' },
  };
  const out = calcDistribution(records, 'type', attrs, FX);
  assert.equal(out.stock, 0);
  assert.equal(out.bond, 200);
});

// ---- driftForRule ----

test('driftForRule: full match — matching_total = sum of all matching records', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 600 },
    { id: 'b', currency: 'TWD', value: 400 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 1000);
  assert.equal(out.actual.stock, 60);
  assert.equal(out.actual.bond, 40);
  assert.equal(out.target.stock, 60);
  assert.equal(out.target.bond, 40);
  assert.equal(out.drift.stock, 0);
  assert.equal(out.drift.bond, 0);
});

test('driftForRule: partial match — only TW records contribute', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 300 }, // TW / stock
    { id: 'b', currency: 'TWD', value: 700 }, // US / bond
    { id: 'c', currency: 'TWD', value: 200 }, // TW / bond
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'US', type: 'bond' },
    c: { country: 'TW', type: 'bond' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 500);
  // TW distribution: stock 300 / bond 200 → stock 60%, bond 40%
  assert.equal(out.actual.stock, 60);
  assert.equal(out.actual.bond, 40);
  assert.equal(out.drift.stock, 0);
  assert.equal(out.drift.bond, 0);
});

test('driftForRule: no match — empty result with target preserved', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 500 },
  ];
  const attrs = { a: { country: 'US' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 0);
  assert.deepEqual(out.actual, {});
  assert.deepEqual(out.drift, {});
  assert.deepEqual(out.target, { stock: 60, bond: 40 });
});

test('driftForRule: single record → 100% actual on its value, full drift on others', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 1000 },
  ];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 1000);
  assert.equal(out.actual.stock, 100);
  assert.equal(out.actual.bond, 0);
  assert.equal(out.drift.stock, 40);
  assert.equal(out.drift.bond, -40);
});

test('driftForRule: _unassigned bucket — some matching records lack target attribute', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100, attributes: { country: 'TW', type: 'stock' } },
    { id: 'b', currency: 'TWD', value: 50, attributes: { country: 'TW', type: 'bond' } },
    { id: 'c', currency: 'TWD', value: 50, attributes: { country: 'TW' } }, // no type
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
    c: { country: 'TW' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 200);
  // filtered_total = 150 (records with type). Normalized: stock 100/150 = 66.67,
  // bond 50/150 = 33.33. _unassigned = 50/200 = 25%.
  assert.equal(out.actual.stock, 100 / 150 * 100);
  assert.equal(out.actual.bond, 50 / 150 * 100);
  assert.equal(out.actual._unassigned, 50 / 200 * 100);
  // Drift over target valueIds still sums to 0 (filtered normalization).
  const driftSum = out.drift.stock + out.drift.bond;
  assert.ok(Math.abs(driftSum) < 1e-9, `drift sum was ${driftSum}`);
});

test('driftForRule: all matching records lack target attribute → actual={_unassigned:100}, drift={}', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },
    { id: 'b', currency: 'TWD', value: 50 },
  ];
  const attrs = {
    a: { country: 'TW' }, // no type
    b: { country: 'TW' }, // no type
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 150);
  assert.deepEqual(out.actual, { _unassigned: 100 });
  assert.deepEqual(out.drift, {});
});

test('driftForRule: empty records / null inputs → no throw, empty result', () => {
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 100 } },
  };
  const out = driftForRule(rule, [], {}, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 0);
  assert.deepEqual(out.actual, {});
  assert.deepEqual(out.drift, {});
});

test('driftForRule: multi-currency — converted to TWD via fxRate', () => {
  const records = [
    { id: 'a', currency: 'USD', value: 10 }, // 320 TWD
    { id: 'b', currency: 'TWD', value: 80 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'stock' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 50, bond: 50 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 400);
  assert.equal(out.actual.stock, 100);
  assert.equal(out.actual.bond, 0);
  assert.equal(out.drift.stock, 50);
  assert.equal(out.drift.bond, -50);
});

test('driftForRule: debt (negative value) contributes negatively to matching_total', () => {
  const records = [
    { id: 'a', currency: 'TWD', value: 1000 }, // holding
    { id: 'b', currency: 'TWD', value: -300 }, // debt
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
  };
  const out = driftForRule(rule, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.matching_total, 700);
  // stock 1000, bond -300 → stock 142.86%, bond -42.86% (over matching_total)
  // Drift: stock 82.86, bond -82.86 (sum 0).
  assert.equal(out.actual.stock, 1000 / 700 * 100);
  assert.equal(out.actual.bond, -300 / 700 * 100);
  const driftSum = out.drift.stock + out.drift.bond;
  assert.ok(Math.abs(driftSum) < 1e-9, `drift sum was ${driftSum}`);
});

// ---- driftForPlan ----

test('driftForPlan: maps driftForRule across plan.rules', () => {
  const plan = {
    id: 'plan-1',
    name: 'Multi',
    rules: [
      { id: 'r1', when: { country: ['TW'] }, distribute: { type: { stock: 60, bond: 40 } } },
      { id: 'r2', when: { country: ['US'] }, distribute: { type: { stock: 70, bond: 30 } } },
    ],
  };
  const records = [
    { id: 'a', currency: 'TWD', value: 600 },
    { id: 'b', currency: 'TWD', value: 400 },
    { id: 'c', currency: 'TWD', value: 700 },
    { id: 'd', currency: 'TWD', value: 300 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
    c: { country: 'US', type: 'stock' },
    d: { country: 'US', type: 'bond' },
  };
  const out = driftForPlan(plan, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.length, 2);
  assert.equal(out[0].matching_total, 1000);
  assert.equal(out[1].matching_total, 1000);
  assert.equal(out[0].actual.stock, 60);
  assert.equal(out[1].actual.stock, 70);
});

test('driftForPlan: mix of matches and non-matches → empty rule drifts preserved', () => {
  const plan = {
    id: 'plan-1',
    name: 'Mixed',
    rules: [
      { id: 'r1', when: { country: ['TW'] }, distribute: { type: { stock: 100 } } },
      { id: 'r2', when: { country: ['JP'] }, distribute: { type: { stock: 100 } } },
    ],
  };
  const records = [{ id: 'a', currency: 'TWD', value: 500 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const out = driftForPlan(plan, records, attrs, ALL_CATEGORIES, FX);
  assert.equal(out.length, 2);
  assert.equal(out[0].matching_total, 500);
  assert.equal(out[1].matching_total, 0);
});

test('driftForPlan: empty plan / null plan → []', () => {
  assert.deepEqual(driftForPlan(null, [], {}, ALL_CATEGORIES, FX), []);
  assert.deepEqual(driftForPlan({ rules: [] }, [], {}, ALL_CATEGORIES, FX), []);
});

// ---- validatePlans ----

test('validatePlans: valid — active_plan_id references existing plan, no warnings', () => {
  const data = {
    plans: [
      { id: 'plan-1', name: 'A', rules: [{ when: {}, distribute: { type: { stock: 100 } } }] },
      { id: 'plan-2', name: 'B', rules: [{ when: {}, distribute: { type: { stock: 100 } } }] },
    ],
    active_plan_id: 'plan-1',
  };
  const out = validatePlans(data);
  assert.equal(out.valid, true);
  assert.deepEqual(out.warnings, []);
});

test('validatePlans: active_plan_id = null → no warning', () => {
  const data = {
    plans: [
      { id: 'plan-1', name: 'A', rules: [{ when: {}, distribute: { type: { stock: 100 } } }] },
    ],
    active_plan_id: null,
  };
  const out = validatePlans(data);
  assert.equal(out.valid, true);
  assert.deepEqual(out.warnings, []);
});

test('validatePlans: active_plan_id missing entirely → no warning', () => {
  const data = {
    plans: [
      { id: 'plan-1', name: 'A', rules: [{ when: {}, distribute: { type: { stock: 100 } } }] },
    ],
  };
  const out = validatePlans(data);
  assert.equal(out.valid, true);
  assert.deepEqual(out.warnings, []);
});

test('validatePlans: stale active_plan_id (references deleted plan) → warning, not error', () => {
  const data = {
    plans: [
      { id: 'plan-1', name: 'A', rules: [{ when: {}, distribute: { type: { stock: 100 } } }] },
    ],
    active_plan_id: 'plan-deleted',
  };
  const out = validatePlans(data);
  assert.equal(out.valid, true);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /plan-deleted/);
});

test('validatePlans: missing plans array → no throw', () => {
  const data = { active_plan_id: null };
  const out = validatePlans(data);
  assert.equal(out.valid, true);
});

// ---- plansReferencingCategory ----

test('plansReferencingCategory: returns plan ids where category is referenced anywhere (when OR distribute)', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
    {
      id: 'plan-2', name: 'B',
      rules: [{ when: { type: ['stock'] }, distribute: { country: { TW: 100 } } }],
    },
  ];
  // plan-1 references 'country' in `when`, plan-2 references it in `distribute`.
  assert.deepEqual(plansReferencingCategory('country', plans), ['plan-1', 'plan-2']);
  assert.deepEqual(plansReferencingCategory('type', plans), ['plan-1', 'plan-2']);
});

test('plansReferencingCategory: category referenced in distribute also counts', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingCategory('type', plans), ['plan-1']);
});

test('plansReferencingCategory: no match → []', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingCategory('phantom', plans), []);
});

test('plansReferencingCategory: multiple plans → all referenced ids (when OR distribute)', () => {
  const plans = [
    { id: 'p1', name: 'A', rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }] },
    { id: 'p2', name: 'B', rules: [{ when: { type: ['stock'] }, distribute: { country: { TW: 100 } } }] },
    { id: 'p3', name: 'C', rules: [{ when: { country: ['US'] }, distribute: { type: { bond: 100 } } }] },
  ];
  // country appears in: p1.when, p2.distribute, p3.when → all three.
  assert.deepEqual(plansReferencingCategory('country', plans), ['p1', 'p2', 'p3']);
});

test('plansReferencingCategory: null/undefined plans → []', () => {
  assert.deepEqual(plansReferencingCategory('country', null), []);
  assert.deepEqual(plansReferencingCategory('country', undefined), []);
});

// ---- plansReferencingValue ----

test('plansReferencingValue: returns plan ids where value appears in when[cat]', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
    {
      id: 'plan-2', name: 'B',
      rules: [{ when: { country: ['US'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingValue('country', 'TW', plans), ['plan-1']);
  assert.deepEqual(plansReferencingValue('country', 'US', plans), ['plan-2']);
  assert.deepEqual(plansReferencingValue('country', 'JP', plans), []);
});

test('plansReferencingValue: value appears in distribute[cat] also counts', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 60, bond: 40 } } }],
    },
  ];
  assert.deepEqual(plansReferencingValue('type', 'stock', plans), ['plan-1']);
  assert.deepEqual(plansReferencingValue('type', 'bond', plans), ['plan-1']);
});

test('plansReferencingValue: value appears only in `when` (not distribute)', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingValue('country', 'TW', plans), ['plan-1']);
});

test('plansReferencingValue: value appears only in `distribute` (not when)', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingValue('type', 'stock', plans), ['plan-1']);
});

test('plansReferencingValue: no match → []', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  assert.deepEqual(plansReferencingValue('country', 'JP', plans), []);
});

test('plansReferencingValue: multiple plans → all referenced ids', () => {
  const plans = [
    { id: 'p1', name: 'A', rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }] },
    { id: 'p2', name: 'B', rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }] },
    { id: 'p3', name: 'C', rules: [{ when: { country: ['US'] }, distribute: { type: { stock: 100 } } }] },
  ];
  assert.deepEqual(plansReferencingValue('country', 'TW', plans), ['p1', 'p2']);
});

test('plansReferencingValue: value in when[] not in the right category → not matched', () => {
  const plans = [
    {
      id: 'plan-1', name: 'A',
      rules: [{ when: { country: ['TW'] }, distribute: { type: { stock: 100 } } }],
    },
  ];
  // 'TW' is in when.country — looking for TW in type values → no match.
  assert.deepEqual(plansReferencingValue('type', 'TW', plans), []);
});
