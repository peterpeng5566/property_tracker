// tests/rebalance.test.js — Unit tests for lib/rebalance.js (v1.8)
//
// Covers: computeCandidates, computeTotalDrift, executeCandidate.
//
// Source of truth: lib/rebalance.js +
//   .scratch/v1.8-region-aware-rebalance/map.md +
//   docs/adr/0017-rebalance-advisor.md
//
// Records passed to the lib carry an explicit `kind: 'holding' | 'cash'`
// tag (set by the Alpine shim at the call site from data.holdings /
// data.cash_accounts) so the lib can identify the type without coupling
// to the holdings/cash shape. `value` is the per-record net-worth
// contribution in `currency`. The lib reuses Plan.recordsMatchingRule
// for the rule filter so the same predicate semantics apply.
//
// FX conversion goes through lib/format.js toTWD (baseline = TWD) so
// the conversion rule lives in one place. fxRate is passed explicitly
// so tests don't need a browser.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCandidates, computeTotalDrift, executeCandidate } = require('../lib/rebalance.js');

// ---- Fixtures ----

const FX = 32; // 1 USD = 32 TWD

// Categories used across tests.
const TYPE_CAT = {
  id: 'type',
  name: 'Type',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'stock', name: 'Stock' },
    { id: 'bond', name: 'Bond' },
    { id: 'cash', name: 'Cash' },
  ],
};
const COUNTRY_CAT = {
  id: 'country',
  name: 'Country',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'TW', name: '台灣' },
    { id: 'US', name: 'United States' },
  ],
};
const REGION_CAT = {
  id: 'region',
  name: 'Region',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'world', name: 'World' },
    { id: 'cash', name: 'Cash' },
  ],
};

// Records carry kind: 'holding' | 'cash' so the lib can branch on type
// without coupling to the holdings/cash_accounts shape.
function holding(id, currency, shares, currentPrice, attributes) {
  return {
    id,
    kind: 'holding',
    currency,
    shares,
    current_price: currentPrice,
    value: shares * currentPrice,
    attributes: attributes || {},
  };
}
function cash(id, currency, balance, attributes) {
  return {
    id,
    kind: 'cash',
    currency,
    balance,
    value: balance,
    attributes: attributes || {},
  };
}

// A well-formed single-rule plan used as a positive control.
function makePlan(rules) {
  return { id: 'plan-1', name: 'My Targets', rules };
}

// A complete rebalance-eligible rule:
//   - has a finite `target_weight_pct` (ADR 0017 §1)
//   - has `show_in_rebalance: true` (v1.19, ADR 0025)
// Tests that want to exercise the toggle-off / default-off path should
// not use this factory; build the rule inline instead.
function ruleEligible(id, name, target_weight_pct, when, distribute) {
  return {
    id,
    name,
    target_weight_pct,
    when,
    distribute: distribute || { type: { stock: 100 } },
    show_in_rebalance: true,
  };
}

// ---- computeCandidates: empty / ineligible ----

test('computeCandidates: plan with no eligible rules → empty array', () => {
  // All rules lack target_weight_pct (drift-only).
  const plan = makePlan([
    { id: 'r1', name: 'Drift only', when: {}, distribute: { type: { stock: 100 } } },
  ]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 100, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('computeCandidates: plan with target_weight_pct=null → not eligible (null treated as unset)', () => {
  const plan = makePlan([
    { id: 'r1', name: 'Null pct', when: {}, distribute: { type: { stock: 100 } }, target_weight_pct: null },
  ]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 100, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('computeCandidates: plan is null/undefined → empty array', () => {
  assert.deepEqual(computeCandidates(null, { records: [], totalValue: 0, fxRate: FX }), []);
  assert.deepEqual(computeCandidates(undefined, { records: [], totalValue: 0, fxRate: FX }), []);
});

// ---- computeCandidates: single rule, single holding ----

test('computeCandidates: single rule with 1 matched holding → 1 candidate with buy advice', () => {
  // Leaf: target_weight_pct=50, totalValue=10000 TWD → target_value=5000 TWD.
  // 1 matched holding, current_value=1000 TWD → target_shares=5000/100=50.
  // delta_shares = 50 - 10 = +40 → buy 40 shares.
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 50, { type: ['stock'] }),
  ]);
  const records = [holding('h1', 'TWD', 10, 100, { type: 'stock' })];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });

  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'r1');
  assert.equal(out[0].ruleName, 'Stocks');
  assert.equal(out[0].kind, 'holding');
  assert.equal(out[0].targetValue, 5000);
  assert.equal(out[0].currentValue, 1000);
  assert.equal(out[0].delta, 4000);
  assert.equal(out[0].matchedRecords.length, 1);

  const c = out[0].matchedRecords[0];
  assert.equal(c.recordId, 'h1');
  assert.equal(c.currency, 'TWD');
  assert.equal(c.currentValue, 1000);
  assert.equal(c.targetValue, 5000);
  assert.equal(c.delta, 4000);
  assert.equal(c.currentShares, 10);
  assert.equal(c.currentPrice, 100);
  assert.equal(c.targetShares, 50);
  assert.equal(c.deltaShares, 40);
  assert.equal(c.action, 'buy');
});

test('computeCandidates: single rule with 1 matched holding → sell advice when over-allocated', () => {
  // Leaf: target_weight_pct=20, totalValue=10000 → target=2000 TWD.
  // 1 matched holding current_value=5000 TWD → delta=-3000 → sell.
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 20, { type: ['stock'] }),
  ]);
  const records = [holding('h1', 'TWD', 50, 100, { type: 'stock' })];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });

  assert.equal(out.length, 1);
  const c = out[0].matchedRecords[0];
  assert.equal(c.targetShares, 20);
  assert.equal(c.deltaShares, -30);
  assert.equal(c.action, 'sell');
});

// ---- computeCandidates: single rule, multiple holdings (even split of target value) ----

test('computeCandidates: single rule with 3 matched holdings → even split of target_value', () => {
  // User example: leaf needs $200, 2 matched holdings at prices $10 and $20
  // → each gets $100 → 10 shares + 5 shares. Here: 3 holdings, prices 10, 20, 100,
  // all equal current value of $100 → target_value = 30000, split 10000 each.
  // Holdings: 10 shares @ 10 ($100), 5 shares @ 20 ($100), 1 share @ 100 ($100).
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 30, { type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 10, 10, { type: 'stock' }),
    holding('h2', 'TWD', 5, 20, { type: 'stock' }),
    holding('h3', 'TWD', 1, 100, { type: 'stock' }),
  ];
  const out = computeCandidates(plan, { records, totalValue: 100000, fxRate: FX });

  assert.equal(out.length, 1);
  assert.equal(out[0].targetValue, 30000);
  assert.equal(out[0].currentValue, 300);
  assert.equal(out[0].matchedRecords.length, 3);

  // Each holding gets 10000 TWD target. h1: 10000/10=1000 shares. h2: 10000/20=500. h3: 10000/100=100.
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  assert.equal(byId.h1.targetValue, 10000);
  assert.equal(byId.h1.targetShares, 1000);
  assert.equal(byId.h1.deltaShares, 990);
  assert.equal(byId.h1.action, 'buy');
  assert.equal(byId.h2.targetValue, 10000);
  assert.equal(byId.h2.targetShares, 500);
  assert.equal(byId.h2.deltaShares, 495);
  assert.equal(byId.h3.targetValue, 10000);
  assert.equal(byId.h3.targetShares, 100);
  assert.equal(byId.h3.deltaShares, 99);
});

test('computeCandidates: USER EXAMPLE — 2 holdings, prices 10/20, leaf=200 → 10+5 shares', () => {
  // Direct pin of the user's R4-Q1 example. Leaf needs $200 (in TWD),
  // 2 holdings @ 10 and 20, each currently 0 shares.
  // Each holding's target_value = 200/2 = 100. Target shares: 100/10=10, 100/20=5.
  const plan = makePlan([
    ruleEligible('r1', 'My Leaf', 100, { type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 0, 10, { type: 'stock' }),
    holding('h2', 'TWD', 0, 20, { type: 'stock' }),
  ];
  const out = computeCandidates(plan, { records, totalValue: 200, fxRate: FX });

  assert.equal(out[0].targetValue, 200);
  assert.equal(out[0].matchedRecords.length, 2);
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  assert.equal(byId.h1.targetShares, 10);
  assert.equal(byId.h2.targetShares, 5);
});

// ---- computeCandidates: cash rule ----

test('computeCandidates: cash rule → 1 candidate with add/reduce amount advice', () => {
  // Leaf target_weight_pct=20, total=10000 → target=2000 TWD.
  // 1 cash account current_value=800 TWD → delta=+1200 → "add 1200 TWD".
  const plan = makePlan([
    ruleEligible('r1', 'Total Cash', 20, { type: ['cash'] }),
  ]);
  const records = [cash('c1', 'TWD', 800, { type: 'cash' })];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });

  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cash');
  assert.equal(out[0].targetValue, 2000);
  assert.equal(out[0].currentValue, 800);
  assert.equal(out[0].delta, 1200);
  assert.equal(out[0].matchedRecords.length, 1);

  const c = out[0].matchedRecords[0];
  assert.equal(c.recordId, 'c1');
  assert.equal(c.currency, 'TWD');
  assert.equal(c.currentValue, 800);
  assert.equal(c.targetValue, 2000);
  assert.equal(c.delta, 1200);
  assert.equal(c.currentBalance, 800);
  assert.equal(c.targetBalance, 2000);
  assert.equal(c.deltaAmount, 1200);
  assert.equal(c.action, 'add');
});

test('computeCandidates: cash rule → reduce advice when over-cashed', () => {
  // Leaf 10%, total 10000 → target 1000. Current cash 5000 → reduce 4000.
  const plan = makePlan([
    ruleEligible('r1', 'Cash', 10, { type: ['cash'] }),
  ]);
  const records = [cash('c1', 'TWD', 5000, { type: 'cash' })];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });

  const c = out[0].matchedRecords[0];
  assert.equal(c.action, 'reduce');
  assert.equal(c.deltaAmount, -4000);
});

// ---- computeCandidates: multi-rule, no overlap ----

test('computeCandidates: 2 rules, no overlap on holdings → 2 candidate groups', () => {
  const plan = makePlan([
    ruleEligible('r1', 'TW stocks', 30, { country: ['TW'], type: ['stock'] }),
    ruleEligible('r2', 'US stocks', 20, { country: ['US'], type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 10, 100, { country: 'TW', type: 'stock' }),
    holding('h2', 'USD', 5, 100, { country: 'US', type: 'stock' }),
  ];
  const out = computeCandidates(plan, { records, totalValue: 100000, fxRate: FX });

  assert.equal(out.length, 2);
  const byRule = Object.fromEntries(out.map(o => [o.ruleId, o]));
  assert.equal(byRule.r1.matchedRecords.length, 1);
  assert.equal(byRule.r1.matchedRecords[0].recordId, 'h1');
  assert.equal(byRule.r2.matchedRecords.length, 1);
  assert.equal(byRule.r2.matchedRecords[0].recordId, 'h2');
});

// ---- computeCandidates: multi-rule, overlap on 1 holding ----

test('computeCandidates: 2 rules overlap on 1 holding → holding appears in both groups', () => {
  // R4-Q3: multi-rule co-collision = independent rows.
  // h1 matches both rules. Each rule produces an independent candidate row for h1.
  const plan = makePlan([
    ruleEligible('r1', 'TW stocks', 30, { country: ['TW'], type: ['stock'] }),
    ruleEligible('r2', 'All stocks', 50, { type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 10, 100, { country: 'TW', type: 'stock' }),
    holding('h2', 'USD', 5, 100, { country: 'US', type: 'stock' }),
  ];
  const out = computeCandidates(plan, { records, totalValue: 100000, fxRate: FX });

  assert.equal(out.length, 2);
  const byRule = Object.fromEntries(out.map(o => [o.ruleId, o]));
  // r1 matches only h1 (TW only)
  assert.equal(byRule.r1.matchedRecords.length, 1);
  assert.equal(byRule.r1.matchedRecords[0].recordId, 'h1');
  // r2 matches both h1 and h2 (all stocks)
  assert.equal(byRule.r2.matchedRecords.length, 2);
  const r2Ids = byRule.r2.matchedRecords.map(c => c.recordId).sort();
  assert.deepEqual(r2Ids, ['h1', 'h2']);
});

// ---- computeCandidates: FX-aware ----

test('computeCandidates: 1 USD + 1 TWD holding in same leaf → values converted to baseline', () => {
  // Leaf 50%, totalValue 32000 (baseline TWD, already includes FX).
  // target_value = 16000 TWD. Split 8000 each.
  // h1 (USD): value 1000 USD = 32000 TWD; h2 (TWD): value 5000 TWD.
  // totalValue includes the converted USD value (the caller is responsible
  // for summing in baseline currency). The lib trusts the inputs.
  const plan = makePlan([
    ruleEligible('r1', 'Mixed stocks', 50, { type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'USD', 10, 100, { type: 'stock' }),  // 1000 USD = 32000 TWD
    holding('h2', 'TWD', 50, 100, { type: 'stock' }), // 5000 TWD
  ];
  const out = computeCandidates(plan, { records, totalValue: 37000, fxRate: FX });

  assert.equal(out.length, 1);
  assert.equal(out[0].targetValue, 18500);
  assert.equal(out[0].currentValue, 37000); // 32000 + 5000
  // Each record's targetValue is computed in baseline TWD then
  // back-converted to native currency via the fxRate when computing
  // target_shares / target_balance.
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // Per-record fields are in NATIVE currency (the lib back-converts
  // target from baseline to native before computing shares).
  // h1 (USD): 9250 TWD baseline → 289.0625 USD; shares = 289.0625 / 100 = 2.890625.
  // h2 (TWD): 9250 TWD baseline = 9250 TWD native; shares = 9250 / 100 = 92.5.
  assert.equal(byId.h1.currency, 'USD');
  assert.equal(byId.h1.targetValue, 289.0625);
  assert.equal(byId.h1.targetShares, 2.890625);
  assert.equal(byId.h1.action, 'sell');
  assert.equal(byId.h2.currency, 'TWD');
  assert.equal(byId.h2.targetValue, 9250);
  assert.equal(byId.h2.targetShares, 92.5);
  assert.equal(byId.h2.action, 'buy');
});

// ---- computeCandidates: no matched records ----

test('computeCandidates: rule has no matched records → 0 candidates in matchedRecords', () => {
  const plan = makePlan([
    ruleEligible('r1', 'TW stocks', 30, { country: ['TW'], type: ['stock'] }),
  ]);
  const records = [
    holding('h1', 'USD', 5, 100, { country: 'US', type: 'stock' }), // doesn't match TW
  ];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });

  assert.equal(out.length, 1);
  assert.equal(out[0].matchedRecords.length, 0);
  // Even with 0 candidates, the rule is still eligible — UI shows
  // "no matched records" empty state.
  assert.equal(out[0].currentValue, 0);
  assert.equal(out[0].targetValue, 3000);
  assert.equal(out[0].delta, 3000);
});

// ---- computeCandidates: totalValue=0 ----

test('computeCandidates: totalValue=0 → all deltas are negative (everything to zero)', () => {
  // Edge case: portfolio is empty. All eligible rules have target=0.
  // currentValue > target → all deltas negative → all "sell" or "reduce".
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 30, { type: ['stock'] }),
  ]);
  const records = [holding('h1', 'TWD', 10, 100, { type: 'stock' })];
  const out = computeCandidates(plan, { records, totalValue: 0, fxRate: FX });

  assert.equal(out[0].targetValue, 0);
  assert.equal(out[0].delta, -1000);
  assert.equal(out[0].matchedRecords[0].action, 'sell');
});

// ---- computeTotalDrift ----

test('computeTotalDrift: plan with no eligible rules → drift=0, missing=100', () => {
  const plan = makePlan([
    { id: 'r1', name: 'Drift only', when: {}, distribute: { type: { stock: 100 } } },
  ]);
  const out = computeTotalDrift(plan, { records: [], totalValue: 10000, fxRate: FX });
  assert.equal(out.drift, 0);
  assert.equal(out.totalRuleWeight, 0);
  assert.equal(out.missing, 100);
});

test('computeTotalDrift: complete plan (sum=100%) → drift=0 if perfectly aligned', () => {
  // Leaf 50%, total 10000 → target=5000. Matched holding exactly 5000.
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 50, { type: ['stock'] }),
    ruleEligible('r2', 'Cash', 50, { type: ['cash'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 50, 100, { type: 'stock' }),  // 5000
    cash('c1', 'TWD', 5000, { type: 'cash' }),         // 5000
  ];
  const out = computeTotalDrift(plan, { records, totalValue: 10000, fxRate: FX });
  assert.equal(out.drift, 0);
  assert.equal(out.totalRuleWeight, 100);
  assert.equal(out.missing, 0);
});

test('computeTotalDrift: partial plan (sum=70%) → drift reflects actual gap', () => {
  // Leaf 30%, total 10000 → target=3000. Matched holding=5000 → delta=2000.
  // drift = sum of |delta| across all eligible rules = 2000.
  const plan = makePlan([
    ruleEligible('r1', 'Stocks', 30, { type: ['stock'] }),
    ruleEligible('r2', 'Cash', 40, { type: ['cash'] }),
  ]);
  const records = [
    holding('h1', 'TWD', 50, 100, { type: 'stock' }),  // 5000 vs 3000 → drift 2000
    cash('c1', 'TWD', 1000, { type: 'cash' }),         // 1000 vs 4000 → drift 3000
  ];
  const out = computeTotalDrift(plan, { records, totalValue: 10000, fxRate: FX });
  assert.equal(out.drift, 5000); // |2000| + |3000|
  assert.equal(out.totalRuleWeight, 70);
  assert.equal(out.missing, 30);
});

test('computeTotalDrift: empty plan → drift=0, missing=100', () => {
  const out = computeTotalDrift({ id: 'p1', name: 'Empty', rules: [] }, {
    records: [], totalValue: 10000, fxRate: FX,
  });
  assert.equal(out.drift, 0);
  assert.equal(out.totalRuleWeight, 0);
  assert.equal(out.missing, 100);
});

// ---- executeCandidate ----

test('executeCandidate: holding buy → adds shares, returns new holdings array', () => {
  const state = {
    holdings: [
      { id: 'h1', shares: 10, current_price: 100 },
    ],
    cash_accounts: [],
  };
  const out = executeCandidate(state, 'r1', 'h1', { kind: 'holding', deltaShares: 40 });
  assert.equal(out.holdings[0].shares, 50);
  assert.equal(out.holdings[0].id, 'h1');
  // Pure: original state unchanged.
  assert.equal(state.holdings[0].shares, 10);
});

test('executeCandidate: holding sell → subtracts shares', () => {
  const state = {
    holdings: [
      { id: 'h1', shares: 50, current_price: 100 },
    ],
    cash_accounts: [],
  };
  const out = executeCandidate(state, 'r1', 'h1', { kind: 'holding', deltaShares: -30 });
  assert.equal(out.holdings[0].shares, 20);
});

test('executeCandidate: cash adjust (add) → increases balance', () => {
  const state = {
    holdings: [],
    cash_accounts: [
      { id: 'c1', balance: 800 },
    ],
  };
  const out = executeCandidate(state, 'r1', 'c1', { kind: 'cash', deltaAmount: 1200 });
  assert.equal(out.cash_accounts[0].balance, 2000);
  // Pure: original state unchanged.
  assert.equal(state.cash_accounts[0].balance, 800);
});

test('executeCandidate: cash adjust (reduce) → decreases balance', () => {
  const state = {
    holdings: [],
    cash_accounts: [
      { id: 'c1', balance: 5000 },
    ],
  };
  const out = executeCandidate(state, 'r1', 'c1', { kind: 'cash', deltaAmount: -4000 });
  assert.equal(out.cash_accounts[0].balance, 1000);
});

test('executeCandidate: holding with deltaShares=0 (no-op) → shares unchanged', () => {
  const state = {
    holdings: [{ id: 'h1', shares: 50, current_price: 100 }],
    cash_accounts: [],
  };
  const out = executeCandidate(state, 'r1', 'h1', { kind: 'holding', deltaShares: 0 });
  assert.equal(out.holdings[0].shares, 50);
});

test('executeCandidate: record not found → returns state unchanged', () => {
  const state = {
    holdings: [{ id: 'h1', shares: 10 }],
    cash_accounts: [],
  };
  const out = executeCandidate(state, 'r1', 'h999', { kind: 'holding', deltaShares: 40 });
  assert.equal(out.holdings[0].shares, 10);
});

test('executeCandidate: multi-record state → only the target record is updated', () => {
  const state = {
    holdings: [
      { id: 'h1', shares: 10 },
      { id: 'h2', shares: 20 },
    ],
    cash_accounts: [
      { id: 'c1', balance: 1000 },
    ],
  };
  const out = executeCandidate(state, 'r1', 'h2', { kind: 'holding', deltaShares: 5 });
  assert.equal(out.holdings[0].shares, 10); // h1 unchanged
  assert.equal(out.holdings[1].shares, 25); // h2 + 5
  assert.equal(out.cash_accounts[0].balance, 1000); // c1 unchanged
});

// ---- Eligibility: show_in_rebalance (v1.19, ADR 0025) ----

// The toggle decouples rebalance eligibility from "has target_weight_pct".
// Even with a perfectly valid target_weight_pct, the rule is NOT
// rebalance-eligible unless `show_in_rebalance === true`. This blocks
// rules that should only be drift-tracked from showing up on the
// Rebalance page.
test('v1.19 toggle: rule with target_weight_pct but show_in_rebalance=false → not eligible', () => {
  const plan = makePlan([{
    id: 'r1', name: 'Drift-only leaf',
    when: {}, distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
    show_in_rebalance: false,
  }]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 10, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('v1.19 toggle: rule with target_weight_pct but show_in_rebalance absent → not eligible (default off)', () => {
  // Pre-v1.19 rules have no `show_in_rebalance` field. They must NOT
  // auto-promote to rebalance-eligible on upgrade — the user explicitly
  // asked for "default is not showing".
  const plan = makePlan([{
    id: 'r1', name: 'Legacy leaf',
    when: {}, distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
    // no show_in_rebalance
  }]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 10, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('v1.19 toggle: rule with target_weight_pct + show_in_rebalance=true → eligible', () => {
  const plan = makePlan([{
    id: 'r1', name: 'Opted-in leaf',
    when: {}, distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
    show_in_rebalance: true,
  }]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 10, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'r1');
});

test('v1.19 toggle: show_in_rebalance="true" (string) is NOT eligible (strict === true)', () => {
  // The lib does an exact `=== true` check so a stringly-typed "true"
  // doesn't accidentally enable rebalance. Defensive against future API
  // callers that might serialise the field as a JSON string.
  const plan = makePlan([{
    id: 'r1', name: 'String "true" leaf',
    when: {}, distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
    show_in_rebalance: 'true',
  }]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 10, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('v1.19 toggle: show_in_rebalance=1 (number) is NOT eligible (strict === true)', () => {
  const plan = makePlan([{
    id: 'r1', name: 'Number 1 leaf',
    when: {}, distribute: { type: { stock: 100 } },
    target_weight_pct: 50,
    show_in_rebalance: 1,
  }]);
  const out = computeCandidates(plan, {
    records: [holding('h1', 'TWD', 10, 100)],
    totalValue: 10000,
    fxRate: FX,
  });
  assert.deepEqual(out, []);
});

test('v1.19 toggle: computeTotalDrift honours the toggle — un-toggled rules excluded', () => {
  // One opted-in rule (50%) + one drift-only rule (also has weight but
  // not toggled). computeTotalDrift should only sum the opted-in rule.
  const plan = {
    id: 'p1', name: 'Mixed',
    rules: [
      { id: 'r1', name: 'Stocks',
        when: { type: ['stock'] }, distribute: { type: { stock: 100 } },
        target_weight_pct: 50, show_in_rebalance: true },
      { id: 'r2', name: 'Cash (drift only)',
        when: { type: ['cash'] }, distribute: { type: { cash: 100 } },
        target_weight_pct: 50, show_in_rebalance: false },
    ],
  };
  const records = [
    holding('h1', 'TWD', 50, 100, { type: 'stock' }), // 5000
    cash('c1', 'TWD', 5000, { type: 'cash' }),        // 5000
  ];
  const out = computeTotalDrift(plan, { records, totalValue: 10000, fxRate: FX });
  // r1: target=5000 (50% of 10000), current=5000 → delta=0
  // r2: drift-only (toggle off) → excluded
  assert.equal(out.drift, 0);
  assert.equal(out.totalRuleWeight, 50); // only r1 counts
  assert.equal(out.missing, 50);          // 100 - 50
});
