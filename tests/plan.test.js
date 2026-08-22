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

// A well-formed single-rule plan used as a positive control.
function makeGoodPlan(overrides) {
  return Object.assign({
    id: 'plan-good',
    name: 'My Targets',
    rules: [
      {
        id: 'rule-1',
        name: 'Domestic equities',
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

test('newRule: returns an object with id, name: "", when: {}, distribute: {}', () => {
  const r = newRule();
  assert.equal(typeof r.id, 'string');
  assert.ok(r.id.startsWith('rule-'));
  assert.equal(r.name, '');
  assert.deepEqual(r.when, {});
  assert.deepEqual(r.distribute, {});
});

// v1.19 (ADR 0025): newRule defaults show_in_rebalance to false. The
// Rebalance page is opt-in; the user must tick the per-rule checkbox
// in the plan editor to enable it.
test('newRule: v1.19 — defaults show_in_rebalance to false (Rebalance off by default)', () => {
  const r = newRule();
  assert.equal(r.show_in_rebalance, false);
});

test('newPlan / newRule: each call returns a distinct id', () => {
  const a = newPlan('A');
  const b = newPlan('A');
  assert.notEqual(a.id, b.id);
});

// ---- validateRule: target_weight_pct (v1.8, ADR 0017 §1) ----
// target_weight_pct is OPTIONAL on a rule. When set, it marks the rule
// as rebalance-eligible and must be a finite number in [0, 100].
// Missing / null / undefined → rule remains drift-only (existing v1.4
// behaviour preserved). The lib does NOT cross-check distribute when
// target_weight_pct is set; a drift-only rule can still have a valid
// distribute field.

test('validateRule: rule without target_weight_pct → valid (drift-only, existing behaviour)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: target_weight_pct: 0 → valid (lower boundary)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: 0 };
  const out = validateRule(r);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validateRule: target_weight_pct: 100 → valid (upper boundary)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: 100 };
  const out = validateRule(r);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validateRule: target_weight_pct: 50.5 → valid (fractional accepted)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: 50.5 };
  const out = validateRule(r);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validateRule: target_weight_pct: null → valid (explicit null = not set)', () => {
  // JSON null is semantically the same as missing; the lib treats it
  // as "rule is not rebalance-eligible". Tests the JSON-roundtrip
  // case where a field is explicitly nulled rather than deleted.
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: null };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: target_weight_pct: -10 → invalid (below 0)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: -10 };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)));
});

test('validateRule: target_weight_pct: 110 → invalid (above 100)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: 110 };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)));
});

test('validateRule: target_weight_pct: "50" → invalid (string rejected)', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: '50' };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)));
});

test('validateRule: target_weight_pct: NaN → invalid', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: NaN };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)));
});

test('validateRule: target_weight_pct: Infinity → invalid', () => {
  const r = { name: 'TW', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: Infinity };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)));
});

test('validateRule: bad target_weight_pct does not break distribute validation', () => {
  // The target_weight_pct error should be reported IN ADDITION TO any
  // distribute errors, not replacing them. The error contract is
  // "rule is invalid, here are all the reasons".
  const r = { name: '', when: {}, distribute: { type: { stock: 50, bond: 30 } }, target_weight_pct: 110 };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /target_weight_pct/.test(e)), 'has target_weight_pct error');
  assert.ok(out.errors.some(e => /name/.test(e)), 'still reports missing name');
  assert.ok(out.errors.some(e => /sum to 100/.test(e)), 'still reports bad distribute sum');
});

// ---- validateRule: show_in_rebalance (v1.19, ADR 0025) ----

// show_in_rebalance is OPTIONAL — absent / null / undefined is fine.
test('validateRule: show_in_rebalance absent → valid (legacy rules unaffected)', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: show_in_rebalance: null → valid', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } }, show_in_rebalance: null };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: show_in_rebalance: true → valid', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } }, show_in_rebalance: true };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: show_in_rebalance: false → valid (explicit opt-out)', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } }, show_in_rebalance: false };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: show_in_rebalance: "true" (string) → invalid', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } }, show_in_rebalance: 'true' };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /show_in_rebalance/.test(e)), 'has show_in_rebalance error');
});

test('validateRule: show_in_rebalance: 1 (number) → invalid', () => {
  const r = { name: 'X', when: {}, distribute: { type: { stock: 100 } }, show_in_rebalance: 1 };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /show_in_rebalance/.test(e)), 'has show_in_rebalance error');
});

// ---- validateRule ----

test('validateRule: good rule with sum=100 → valid', () => {
  const r = { name: 'TW stock/bond', when: { country: ['TW'] }, distribute: { type: { stock: 60, bond: 40 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
});

test('validateRule: weights sum != 100 → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 50, bond: 30 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /sum to 100/.test(e)));
});

test('validateRule: weights sum 99.99 accepted (FP epsilon)', () => {
  const r = { name: 'Some rule', when: {}, distribute: { type: { stock: 59.99, bond: 40.01 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

// ---- name (T04-prep retroactive; rule name is required at save time) ----

test('validateRule: name present and non-empty → valid', () => {
  const r = { name: 'Domestic equities', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: name missing → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /name/.test(e)), 'should have a name-related error');
});

test('validateRule: name === "" → invalid', () => {
  const r = { name: '', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /name/.test(e)), 'should have a name-related error');
});

test('validateRule: name whitespace-only → invalid', () => {
  const r = { name: '   ', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /name/.test(e)), 'should have a name-related error');
});

test('validateRule: name non-string → invalid', () => {
  const r = { name: 42, when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /name/.test(e)), 'should have a name-related error');
});

test('validateRule: weights sum 100.02 rejected', () => {
  const r = { when: {}, distribute: { type: { stock: 60.02, bond: 40 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /sum to 100/.test(e)));
});

test('validateRule: empty distribute (no key) → invalid', () => {
  const r = { when: {}, distribute: {} };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /exactly 1 key/.test(e)));
});

test('validateRule: multi-key distribute → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 100 }, country: { TW: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /exactly 1 key/.test(e)));
});

test('validateRule: empty when is allowed (matches all records)', () => {
  const r = { name: 'Catch-all', when: {}, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, true);
});

test('validateRule: when value is not an array → invalid', () => {
  const r = { when: { country: 'TW' }, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /when\.country must be an array/.test(e)));
});

test('validateRule: when value is array of non-strings → invalid', () => {
  const r = { when: { country: [1, 2] }, distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /non-empty strings/.test(e)));
});

test('validateRule: when is an Array (not plain object) → invalid', () => {
  const r = { when: ['TW'], distribute: { type: { stock: 100 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /when must be a plain object/.test(e)));
});

test('validateRule: missing distribute → invalid', () => {
  const r = { when: {} };
  const out = validateRule(r);
  assert.equal(out.valid, false);
});

test('validateRule: negative weight → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 110, bond: -10 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some(e => /non-negative finite number/.test(e)));
});

test('validateRule: non-numeric weight → invalid', () => {
  const r = { when: {}, distribute: { type: { stock: 'sixty', bond: 40 } } };
  const out = validateRule(r);
  assert.equal(out.valid, false);
});

test('validateRule: rule referencing non-existent category ids is allowed (UI-layer check, not lib)', () => {
  // The lib does not require category ids referenced by when / distribute
  // to exist in the category list. That check belongs in the UI layer so
  // a user can save a plan referencing a category they just deleted — see
  // plansReferencingCategory for the delete-protection path.
  const r = { name: 'Ghost rule', when: { ghost: ['x'] }, distribute: { phantom: { y: 100 } } };
  const out = validateRule(r);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
  assert.equal(out.matching_total, 150);
  assert.deepEqual(out.actual, { _unassigned: 100 });
  assert.deepEqual(out.drift, {});
});

test('driftForRule: empty records / null inputs → no throw, empty result', () => {
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 100 } },
  };
  const out = driftForRule(rule, [], {}, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForRule(rule, records, attrs, FX);
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
  const out = driftForPlan(plan, records, attrs, FX);
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
  const out = driftForPlan(plan, records, attrs, FX);
  assert.equal(out.length, 2);
  assert.equal(out[0].matching_total, 500);
  assert.equal(out[1].matching_total, 0);
});

test('driftForPlan: empty plan / null plan → []', () => {
  assert.deepEqual(driftForPlan(null, [], {}, FX), []);
  assert.deepEqual(driftForPlan({ rules: [] }, [], {}, FX), []);
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

// ============================================================================
// v1.17 — driftForRule amount columns
// ============================================================================
//
// The v1.17 data-layer extension (ADR 0024):
//   - `driftForRule` (and `driftForPlan`) gain an optional 5th arg
//     `netWorth` (number, in baseline TWD).
//   - When `netWorth` is provided, the returned shape gains:
//       rule_target_amount : number  (TWD; rule's total target value)
//       target_amount      : { [vid]: TWD }  per distribute value_id
//       actual_amount      : { [vid]: TWD }  per distribute value_id
//       drift_amount       : { [vid]: TWD }  actual - target
//   - When `netWorth` is absent, the shape is unchanged (backward compat).
//   - Missing `target_weight_pct` is treated as 100 on the Home page
//     (different from Rebalance's "missing = not eligible" per ADR 0017 §1).
//   - All amounts are in baseline TWD; the Alpine shim converts to
//     displayCurrency via `formatAmount(twd, 'TWD')`.
//   - Debt records contribute negative `actual_amount` (Q6 = a).
//   - The `_unassigned` bucket has no `target_amount` (unassigned is not
//     in `distribute`) but does have `actual_amount` (the negative of the
//     filtered-out portion).

// ---- Slice 1: backward-compat — 4-arg call returns unchanged shape ----

test('driftForRule v1.17: 4-arg call (no netWorth) → no new amount fields', () => {
  // Backward-compat: existing callers (Alpine shim pre-v1.17, all current
  // tests) pass only 4 args. The v1.17 extension is purely additive.
  const records = [{ id: 'a', currency: 'TWD', value: 100 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 50,
  };
  const out = driftForRule(rule, records, attrs, FX);
  assert.equal(out.matching_total, 100);
  assert.equal(out.actual.stock, 100);
  assert.equal(out.target.stock, 60);
  assert.equal(out.drift.stock, 40);
  // No new amount fields when netWorth is absent.
  assert.equal('rule_target_amount' in out, false);
  assert.equal('target_amount' in out, false);
  assert.equal('actual_amount' in out, false);
  assert.equal('drift_amount' in out, false);
});

// ---- Slice 2: rule_target_amount math — target_weight_pct = 100 → rule_target_amount = netWorth ----

test('driftForRule v1.17: target_weight_pct=100 → rule_target_amount = netWorth', () => {
  // The simplest case: 100% target weight means the rule should hold
  // the entire portfolio. rule_target_amount equals netWorth verbatim.
  const records = [];
  const attrs = {};
  const rule = {
    when: {},
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 100,
  };
  const netWorth = 1000000;
  const out = driftForRule(rule, records, attrs, FX, netWorth);
  assert.equal(out.rule_target_amount, 1000000);
});

// ---- Slice 3: partial target_weight_pct math — rule_target_amount = netWorth × pct / 100 ----

test('driftForRule v1.17: target_weight_pct=50 → rule_target_amount = netWorth/2', () => {
  const records = [];
  const attrs = {};
  const rule = {
    when: {},
    distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
  };
  const out = driftForRule(rule, records, attrs, FX, 1000000);
  assert.equal(out.rule_target_amount, 500000);
});

test('driftForRule v1.17: target_weight_pct=0 → rule_target_amount = 0', () => {
  const records = [];
  const attrs = {};
  const rule = {
    when: {},
    distribute: { type: { stock: 100 } },
    target_weight_pct: 0,
  };
  const out = driftForRule(rule, records, attrs, FX, 1000000);
  assert.equal(out.rule_target_amount, 0);
});

// ---- Slice 4: treat-missing-as-100 (ADR 0024 §2) ----

test('driftForRule v1.17: missing target_weight_pct → rule_target_amount = netWorth (treat as 100)', () => {
  // Different from Rebalance (ADR 0017 §1, missing = not eligible): on
  // the Home page, missing means "this rule claims the full portfolio
  // within its distribute weights". A pre-v1.8 plan with no
  // target_weight_pct retroactively becomes a 100% rule.
  const records = [];
  const attrs = {};
  const rule = {
    when: {},
    distribute: { type: { stock: 60, bond: 40 } },
    // no target_weight_pct
  };
  const out = driftForRule(rule, records, attrs, FX, 1000000);
  assert.equal(out.rule_target_amount, 1000000);
});

test('driftForRule v1.17: explicit target_weight_pct=null → rule_target_amount = netWorth (treat as 100)', () => {
  // JSON-roundtrip case: null is semantically the same as missing.
  const rule = {
    when: {},
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: null,
  };
  const out = driftForRule(rule, [], {}, FX, 1000000);
  assert.equal(out.rule_target_amount, 1000000);
});

// ---- Slice 5: target_amount per value_id ----

test('driftForRule v1.17: target_amount splits rule_target_amount across distribute weights', () => {
  // 100% weight, distribute 70/30 → target_amount.stock = 700K,
  // target_amount.bond = 300K. Verified against a hand-computed
  // expected value (independent of the lib's calculation).
  const rule = {
    when: {},
    distribute: { type: { stock: 70, bond: 30 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, [], {}, FX, 1000000);
  assert.equal(out.target_amount.stock, 700000);
  assert.equal(out.target_amount.bond, 300000);
});

test('driftForRule v1.17: target_amount scales with partial target_weight_pct', () => {
  // 50% rule, distribute 60/40 → target_amount.stock = 500K × 0.6 = 300K,
  // target_amount.bond = 200K. Pinned by hand computation.
  const rule = {
    when: {},
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 50,
  };
  const out = driftForRule(rule, [], {}, FX, 1000000);
  assert.equal(out.target_amount.stock, 300000);
  assert.equal(out.target_amount.bond, 200000);
});

// ---- Slice 6: actual_amount per value_id (sum of records' TWD values) ----

test('driftForRule v1.17: actual_amount sums matching records per value_id', () => {
  // Two matching records, both with type=stock:
  //   a: TWD 100000
  //   b: TWD 50000
  // Expected actual_amount.stock = 150000 (TWD baseline). Hand-computed.
  const records = [
    { id: 'a', currency: 'TWD', value: 100000 },
    { id: 'b', currency: 'TWD', value: 50000 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'stock' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 200000);
  assert.equal(out.actual_amount.stock, 150000);
  // No records have type=bond → actual_amount.bond is 0 (not undefined).
  assert.equal(out.actual_amount.bond, 0);
});

test('driftForRule v1.17: actual_amount converts USD records via fxRate to TWD', () => {
  // 1 USD record worth 1000 USD @ fxRate 32 = 32000 TWD.
  const records = [
    { id: 'a', currency: 'USD', value: 1000 },
  ];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 100 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 50000);
  assert.equal(out.actual_amount.stock, 32000);
});

// ---- Slice 7: drift_amount per value_id = actual - target ----

test('driftForRule v1.17: drift_amount = actual_amount - target_amount', () => {
  // target_amount.stock = 100K, actual_amount.stock = 60K → drift = -40K
  // (hand-computed).
  const records = [{ id: 'a', currency: 'TWD', value: 60000 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 100 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 100000);
  assert.equal(out.target_amount.stock, 100000);
  assert.equal(out.actual_amount.stock, 60000);
  assert.equal(out.drift_amount.stock, -40000);
});

test('driftForRule v1.17: drift_amount = 0 when actual exactly matches target', () => {
  // target = 100K (100% × 100K), actual = 100K (full TWD sum) → drift = 0.
  const records = [{ id: 'a', currency: 'TWD', value: 100000 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 100 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 100000);
  assert.equal(out.drift_amount.stock, 0);
});

// ---- Slice 8: 0-matching rule edge case ----

test('driftForRule v1.17: 0-matching rule → actual_amount={}, drift_amount=-target_amount per vid', () => {
  // No records match the rule (filter excludes everything). The %
  // column is undefined (existing behaviour); the $ column shows the
  // full negative target per value_id (ADR 0024 §4 — informative).
  // Hand-computed: target_amount.stock = 70K, drift = -70K.
  const records = [{ id: 'a', currency: 'TWD', value: 100 }];
  const attrs = { a: { country: 'US' } }; // not TW
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 70, bond: 30 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 100000);
  assert.equal(out.matching_total, 0);
  assert.deepEqual(out.actual, {});
  assert.deepEqual(out.drift, {});
  assert.equal(out.target_amount.stock, 70000);
  assert.equal(out.target_amount.bond, 30000);
  assert.deepEqual(out.actual_amount, {}); // no actual when no records
  assert.equal(out.drift_amount.stock, -70000);
  assert.equal(out.drift_amount.bond, -30000);
});

// ---- Slice 9: debt-negative actual (Q6 = a, preserve negative) ----

test('driftForRule v1.17: debt record (negative value) → negative actual_amount, large negative drift', () => {
  // A rule matches a debt record (value = -50K TWD). The debt bucket's
  // actual_amount is -50K (preserved verbatim per Q6 = a). target = 50K
  // (50% of 100K), so drift = -50K - 50K = -100K. Hand-computed.
  const records = [{ id: 'a', currency: 'TWD', value: -50000 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 50, bond: 50 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 100000);
  assert.equal(out.matching_total, -50000);
  assert.equal(out.actual_amount.stock, -50000);
  assert.equal(out.target_amount.stock, 50000);
  assert.equal(out.drift_amount.stock, -100000);
});

test('driftForRule v1.17: debt record mixed with holding → matching_total offsets', () => {
  // 1 holding (+100K) + 1 debt (-30K) match the same rule:
  //   matching_total = 70K (positive net)
  //   actual_amount.stock = 100K (holding only, debt is in different bucket)
  // Verify the lib correctly separates holding vs debt by value_id.
  const records = [
    { id: 'h', currency: 'TWD', value: 100000 }, // holding
    { id: 'd', currency: 'TWD', value: -30000 }, // debt
  ];
  const attrs = {
    h: { country: 'TW', type: 'stock' },
    d: { country: 'TW', type: 'bond' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 200000);
  assert.equal(out.matching_total, 70000);
  assert.equal(out.actual_amount.stock, 100000);
  assert.equal(out.actual_amount.bond, -30000);
  assert.equal(out.target_amount.stock, 120000);
  assert.equal(out.target_amount.bond, 80000);
  assert.equal(out.drift_amount.stock, -20000);
  assert.equal(out.drift_amount.bond, -110000);
});

// ---- Slice 10: net worth = 0 ----

test('driftForRule v1.17: net worth = 0 → all target amounts = 0, drift = -actual', () => {
  // With netWorth = 0 and only stock records, the lib reports:
  //   target = 0 for both value_ids (no portfolio to allocate)
  //   actual.stock = 50000 (the only matching record)
  //   drift.stock = 50000 - 0 = 50000 (over-target on stock; "I have
  //     more stock than my 0-weight target wants")
  //   drift.bond = 0 - 0 = 0 (no bond records, no bond target)
  const records = [{ id: 'a', currency: 'TWD', value: 50000 }];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 50, bond: 50 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 0);
  assert.equal(out.rule_target_amount, 0);
  assert.equal(out.target_amount.stock, 0);
  assert.equal(out.target_amount.bond, 0);
  assert.equal(out.actual_amount.stock, 50000);
  assert.equal(out.drift_amount.stock, 50000);
  assert.equal(out.drift_amount.bond, 0);
});

// ---- Slice 11: negative net worth (large debt > holdings+cash) ----

test('driftForRule v1.17: negative net worth → rule_target_amount is negative (ADR 0024 §2)', () => {
  // When net worth is negative (large debt), the rule_target_amount is
  // also negative. This is the "loud signal" that the user's plan is
  // broken — documented in ADR 0024 §2 as informative rather than clamped.
  const rule = {
    when: {},
    distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
  };
  const out = driftForRule(rule, [], {}, FX, -200000);
  assert.equal(out.rule_target_amount, -100000);
  assert.equal(out.target_amount.stock, -100000);
});

// ---- Slice 12: driftForPlan mirrors the new shape ----

test('driftForPlan v1.17: threads netWorth through and mirrors new fields per rule', () => {
  const plan = {
    id: 'plan-1',
    name: 'Multi',
    rules: [
      { id: 'r1', when: { country: ['TW'] }, distribute: { type: { stock: 100 } }, target_weight_pct: 50 },
      { id: 'r2', when: { country: ['US'] }, distribute: { type: { stock: 100 } }, target_weight_pct: 100 },
    ],
  };
  const records = [
    { id: 'a', currency: 'TWD', value: 300000 },
  ];
  const attrs = { a: { country: 'TW', type: 'stock' } };
  const out = driftForPlan(plan, records, attrs, FX, 1000000);
  assert.equal(out.length, 2);
  // r1: 50% weight → rule_target_amount = 500K; matches 300K TWD holding.
  assert.equal(out[0].rule_target_amount, 500000);
  assert.equal(out[0].actual_amount.stock, 300000);
  assert.equal(out[0].target_amount.stock, 500000);
  assert.equal(out[0].drift_amount.stock, -200000);
  // r2: 100% weight, no matches → rule_target_amount = 1M; actual_amount = {}.
  assert.equal(out[1].rule_target_amount, 1000000);
  assert.deepEqual(out[1].actual_amount, {});
  assert.equal(out[1].drift_amount.stock, -1000000);
});

test('driftForPlan v1.17: 4-arg call (no netWorth) → no new fields on any rule entry', () => {
  // Backward-compat: driftForPlan without netWorth returns the v1.4
  // shape for every rule entry (no rule_target_amount / *_amount fields).
  const plan = {
    id: 'plan-1',
    name: 'X',
    rules: [
      { id: 'r1', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: 50 },
    ],
  };
  const records = [{ id: 'a', currency: 'TWD', value: 100000 }];
  const attrs = { a: { type: 'stock' } };
  const out = driftForPlan(plan, records, attrs, FX);
  assert.equal(out.length, 1);
  assert.equal('rule_target_amount' in out[0], false);
  assert.equal('target_amount' in out[0], false);
  assert.equal('actual_amount' in out[0], false);
  assert.equal('drift_amount' in out[0], false);
});

// ---- Slice 12.5: _unassigned bucket does NOT appear in actual_amount (ADR 0024 §6) ----

test('driftForRule v1.17: _unassigned bucket is excluded from actual_amount', () => {
  // The existing v1.4 drift sets `actual._unassigned` when matching records
  // lack the target attribute (percentage form). v1.17 `actual_amount` is
  // built only over distribute value_ids — the unassigned bucket has no
  // target (it's not in `distribute`), so it cannot meaningfully participate
  // in the target/actual/drift comparison. ADR 0024 §6 documents this as
  // intentional: actual_amount stays consistent (no surprise keys), and
  // the Alpine shim renders the unassigned row's $ column as `—`.
  const records = [
    { id: 'a', currency: 'TWD', value: 100 },  // has type
    { id: 'b', currency: 'TWD', value: 50 },   // no type (unassigned)
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW' }, // no type
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 200000);
  // % shape: actual has _unassigned (existing v1.4 behaviour).
  assert.ok('_unassigned' in out.actual, 'actual has _unassigned (pct form)');
  // $ shape: actual_amount has NO _unassigned key.
  assert.equal('_unassigned' in out.actual_amount, false,
    'actual_amount should not contain _unassigned');
  // $ shape: actual_amount covers only distribute value_ids.
  assert.deepEqual(Object.keys(out.actual_amount).sort(), ['bond', 'stock']);
  assert.equal(out.actual_amount.stock, 100);
  assert.equal(out.actual_amount.bond, 0);
});

test('driftForRule v1.17: when all matching records lack target attribute → actual_amount = {}', () => {
  // Mirrors the v1.4 behaviour: all matching records lack the target
  // attribute → actual._unassigned = 100, drift = {}. v1.17 extends this:
  // actual_amount stays empty (nothing to sum per distribute vid) and
  // drift_amount is computed against the rule's target. Hand-computed:
  // rule_target_amount = 100K (100% of 100K net worth); target_amount =
  // { stock: 60K, bond: 40K }; actual_amount = {} (no records with
  // target attribute); drift_amount = { stock: -60K, bond: -40K }.
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
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 100000);
  assert.equal(out.matching_total, 150);
  assert.deepEqual(out.actual, { _unassigned: 100 });
  assert.deepEqual(out.drift, {});
  // v1.17: actual_amount is empty (no records with target attribute),
  // but target_amount + drift_amount are still computed.
  assert.deepEqual(out.actual_amount, {});
  assert.equal(out.target_amount.stock, 60000);
  assert.equal(out.target_amount.bond, 40000);
  assert.equal(out.drift_amount.stock, -60000);
  assert.equal(out.drift_amount.bond, -40000);
});

// ---- Slice 13: actual_amount total symmetry (within-rule) ----

test('driftForRule v1.17: Σ actual_amount across distribute value_ids + unassigned = matching_total', () => {
  // The lib's calcDistribution separates `dist` (per-value-id sums) from
  // the unassigned bucket. When all matching records carry the target
  // attribute, the sum of actual_amount values equals matching_total.
  // Verified by hand: 100K + 50K = 150K.
  const records = [
    { id: 'a', currency: 'TWD', value: 100000 },
    { id: 'b', currency: 'TWD', value: 50000 },
  ];
  const attrs = {
    a: { country: 'TW', type: 'stock' },
    b: { country: 'TW', type: 'bond' },
  };
  const rule = {
    when: { country: ['TW'] },
    distribute: { type: { stock: 60, bond: 40 } },
    target_weight_pct: 100,
  };
  const out = driftForRule(rule, records, attrs, FX, 200000);
  const sumActual = out.actual_amount.stock + out.actual_amount.bond;
  assert.equal(sumActual, out.matching_total);
  assert.equal(sumActual, 150000);
});
