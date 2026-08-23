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
const { toTWD } = require('../lib/format.js');

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

test('computeCandidates: single rule with 3 matched holdings → bucket target on every row', () => {
  // v1.20 (ADR 0026): with single value_id at 100% weight, the whole
  // rule is one bucket — each row gets the bucket target (rule_target
  // = 30000), NOT divided by matchedCount. The 3 holdings then each
  // reach their own target_share based on their current_price.
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

  // Each row gets the full bucket_target = 30000 TWD.
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  assert.equal(byId.h1.targetValue, 30000);
  assert.equal(byId.h1.targetShares, 3000);  // 30000/10
  // v1.20.1 fix: per-row deltaShares = bucket_delta / current_price.
  // bucket.current = 300, bucket.target = 30000, bucket.delta = +29700.
  assert.equal(byId.h1.deltaShares, 2970);  // 29700/10
  assert.equal(byId.h1.action, 'buy');
  assert.equal(byId.h2.targetValue, 30000);
  assert.equal(byId.h2.targetShares, 1500);  // 30000/20
  assert.equal(byId.h2.deltaShares, 1485);  // 29700/20
  assert.equal(byId.h3.targetValue, 30000);
  assert.equal(byId.h3.targetShares, 300);   // 30000/100
  assert.equal(byId.h3.deltaShares, 297);    // 29700/100
});

test('computeCandidates: USER EXAMPLE — 2 holdings, prices 10/20, leaf=200 → 20+10 shares', () => {
  // v1.20 (ADR 0026): direct pin of the user's R4-Q1 example, updated
  // for the new semantics. Leaf needs $200 (TWD), 2 holdings @ 10 and
  // 20, each currently 0 shares. With single value_id 100% weight, the
  // whole rule is one bucket — each row gets target_value = 200 (NOT
  // 100). Target shares: 200/10=20, 200/20=10.
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
  assert.equal(byId.h1.targetShares, 20);
  assert.equal(byId.h2.targetShares, 10);
});

// ---- v1.20.1 fix: per-row Action = bucket_delta / current_price ----
//
// Regression for the v1.20 close-out: a multi-record bucket's per-row
// Action was being computed as `(bucket_target - record.current) /
// price`, so each row got its own delta that summed to MORE than the
// bucket delta when executed on multiple rows. Correct semantics:
// Action = bucket_delta / row's price, so executing on any ONE row
// fully closes the bucket (the user picks which row to execute on).
// See ADR 0026 §1 ("same dollar on both surfaces") extended to per-row
// share math.

test('computeCandidates: 2-record over-allocated bucket → Action = bucket_delta / price per row', () => {
  // Mirror the screenshot scenario: 00631L.TW (cheap) + 00675L.TW
  // (expensive) in the same bucket, both over-allocated. The bucket
  // needs to SELL $550K total. Each row's Action must equal the
  // bucket delta expressed in THAT row's share count — so executing
  // either row alone closes the bucket.
  const plan = makePlan([
    ruleEligible('r1', 'TW domestic', 55, { type: ['stock'] }, { type: { stock: 100 } }),
  ]);
  const records = [
    // Cheap stock: 10000 shares @ $100 = $1,000,000
    holding('cheap', 'TWD', 10000, 100, { type: 'stock' }),
    // Expensive stock: 100 shares @ $1000 = $100,000
    holding('expensive', 'TWD', 100, 1000, { type: 'stock' }),
  ];
  // totalValue=2000000; rule_target = 55% × 2000000 = $1,100,000
  // (entire bucket weight = 100%, so bucket.target = $1,100,000)
  const out = computeCandidates(plan, { records, totalValue: 2000000, fxRate: FX });

  // Rule-level: bucket.current = 1,100,000, bucket.target = 1,100,000,
  // bucket.delta = 0. Over-allocatedness comes from deliberately
  // targetting LESS than current. Adjust: re-target with totalValue=1M
  // → rule_target = $550K (overshooting current by $550K under-alloc
  // would do the opposite). We want OVER-allocated: rule target < current.
  // Re-compute with totalValue=1M: rule_target = 55% × 1M = $550K.
  // bucket.current = $1.1M, bucket.delta = $550K - $1.1M = -$550K.
  // Actually we passed totalValue=2000000 — re-check.
  // 55% × 2,000,000 = 1,100,000. bucket.current = 1,100,000. delta=0.
  // To get OVER-allocated: totalValue must produce rule_target < current.
  // Use totalValue=500000: rule_target = 275000 < 1100000 = current.
  // Replace and re-assert.

  // Recompute with over-allocated scenario:
  const outOver = computeCandidates(plan, { records, totalValue: 500000, fxRate: FX });

  assert.equal(outOver.length, 1);
  assert.equal(outOver[0].targetValue, 275000);          // rule_target
  assert.equal(outOver[0].currentValue, 1100000);        // sum of record values
  assert.equal(outOver[0].delta, -825000);               // 275K - 1.1M

  const byId = Object.fromEntries(outOver[0].matchedRecords.map(c => [c.recordId, c]));
  // Both rows show the SAME bucket delta (same target, same bucket.current).
  assert.equal(byId.cheap.targetValue, 275000);
  assert.equal(byId.expensive.targetValue, 275000);
  assert.equal(byId.cheap.delta, -825000);
  assert.equal(byId.expensive.delta, -825000);

  // Per-row target_shares = bucket.target / row's price (each row would
  // reach the FULL bucket target — kept from v1.20 for display).
  assert.equal(byId.cheap.targetShares, 2750);           // 275000 / 100
  assert.equal(byId.expensive.targetShares, 275);        // 275000 / 1000

  // FIX: per-row deltaShares = bucket.delta / row's price.
  // Bucket delta = -825000. Cheap: -825000/100 = -8250 shares = -8.25L.
  // Expensive: -825000/1000 = -825 shares = -0.83L.
  assert.equal(byId.cheap.deltaShares, -8250);
  assert.equal(byId.expensive.deltaShares, -825);

  // Both rows say SELL (over-allocated bucket).
  assert.equal(byId.cheap.action, 'sell');
  assert.equal(byId.expensive.action, 'sell');

  // Invariant: executing ANY ONE row's Action fully closes the bucket.
  // cheap: -8250 shares × $100 = -$825,000 ≈ bucket delta ✓
  // expensive: -825 shares × $1000 = -$825,000 ≈ bucket delta ✓
  const cheapExec = byId.cheap.deltaShares * byId.cheap.currentPrice;
  const expensiveExec = byId.expensive.deltaShares * byId.expensive.currentPrice;
  assert.equal(cheapExec, -825000);
  assert.equal(expensiveExec, -825000);
});

test('computeCandidates: 2-record under-allocated bucket → Action = bucket_delta / price per row (buy)', () => {
  // Same bucket shape as the over-allocated test, but the bucket is
  // under-allocated → both rows should say BUY and the per-row
  // deltaShares must reflect bucket_delta / price.
  const plan = makePlan([
    ruleEligible('r1', 'TW domestic', 80, { type: ['stock'] }, { type: { stock: 100 } }),
  ]);
  const records = [
    holding('cheap', 'TWD', 10000, 100, { type: 'stock' }),       // 1M
    holding('expensive', 'TWD', 100, 1000, { type: 'stock' }),     // 100K
  ];
  // totalValue=2M, rule_target=80%×2M = 1.6M; bucket.current=1.1M;
  // bucket.delta = +500K.
  const out = computeCandidates(plan, { records, totalValue: 2000000, fxRate: FX });
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));

  assert.equal(byId.cheap.delta, 500000);
  assert.equal(byId.expensive.delta, 500000);
  // bucket_delta / price
  assert.equal(byId.cheap.deltaShares, 5000);           // 500000 / 100
  assert.equal(byId.expensive.deltaShares, 500);        // 500000 / 1000
  assert.equal(byId.cheap.action, 'buy');
  assert.equal(byId.expensive.action, 'buy');
});

// ---- computeCandidates: cash rule ----

test('computeCandidates: cash rule → 1 candidate with add/reduce amount advice', () => {
  // Leaf target_weight_pct=20, total=10000 → rule_target=2000 TWD.
  // 1 cash account current_value=800 TWD → delta=+1200 → "add 1200 TWD".
  // v1.20 (ADR 0026): distribute must cover 'cash' value_id so the
  // record is in a real bucket (otherwise it would fall into
  // _unassigned with target=0).
  const plan = makePlan([
    ruleEligible('r1', 'Total Cash', 20, { type: ['cash'] }, { type: { cash: 100 } }),
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
  // Leaf 10%, total 10000 → rule_target 1000. Current cash 5000 → reduce 4000.
  // v1.20 (ADR 0026): distribute must cover 'cash' value_id.
  const plan = makePlan([
    ruleEligible('r1', 'Cash', 10, { type: ['cash'] }, { type: { cash: 100 } }),
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
  // v1.20 (ADR 0026): single value_id 100% → whole rule is one bucket.
  // rule_target = 50% × 37000 = 18500 TWD. Each row gets the full
  // bucket_target (NOT divided by 2). Per-row fields in native currency.
  // h1 (USD): 1000 USD = 32000 TWD; h2 (TWD): 5000 TWD.
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
  // Per-record fields are in NATIVE currency (the lib back-converts
  // the bucket target from baseline TWD to native before computing
  // shares).
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // h1 (USD): 18500 TWD baseline → 578.125 USD; shares = 578.125 / 100 = 5.78125.
  // h2 (TWD): 18500 TWD baseline = 18500 TWD native; shares = 18500 / 100 = 185.
  assert.equal(byId.h1.currency, 'USD');
  assert.equal(byId.h1.targetValue, 578.125);
  assert.equal(byId.h1.targetShares, 5.78125);
  // v1.20.1 fix: bucket is OVER-allocated (current 37000 > target
  // 18500). Per-row action = bucket_delta / price, same direction on
  // every row (matches bucket direction, not per-record direction).
  // h1 USD: bucket_delta -18500 TWD → -578.125 USD → -5.78125 shares → sell.
  // h2 TWD: same bucket_delta -18500 TWD → -18500 TWD → -185 shares → sell.
  assert.equal(byId.h1.action, 'sell');
  assert.equal(byId.h2.currency, 'TWD');
  assert.equal(byId.h2.targetValue, 18500);
  assert.equal(byId.h2.targetShares, 185);
  assert.equal(byId.h2.action, 'sell');
  // deltaShares check: h2 is -185 (was +135 under the old buggy
  // targetShares - currentShares formula).
  assert.equal(byId.h2.deltaShares, -185);
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

// ---- v1.20 (ADR 0026): bucket-weighted split ----

test('v1.20: multi-value distribute weights split rule_target across buckets', () => {
  // distribute { region: { US: 75, TW: 25 } }.
  // rule_target = 30% × 100k = 30k TWD. US bucket_target = 22500,
  // TW bucket_target = 7500. Each record in a bucket sees its bucket
  // target (NOT divided by bucket count).
  const plan = makePlan([
    ruleEligible('r1', 'Split', 30, {}, { region: { US: 75, TW: 25 } }),
  ]);
  const records = [
    holding('us1', 'USD', 100, 100, { region: 'US' }), // 10000 USD = 320k TWD
    holding('tw1', 'TWD', 100, 100, { region: 'TW' }), // 10k TWD
  ];
  const out = computeCandidates(plan, { records, totalValue: 100000, fxRate: FX });

  assert.equal(out.length, 1);
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // us1: bucket_target = 22500 TWD → 22500/32 = 703.125 USD; target_shares = 703.125/100 = 7.03125
  assert.equal(Math.round(toTWD(byId.us1.targetValue, 'USD', FX)), 22500);
  // tw1: bucket_target = 7500 TWD → 7500 TWD; target_shares = 7500/100 = 75
  assert.equal(byId.tw1.targetValue, 7500);
});

test('v1.20: no-distribute fallback uses synthetic _all bucket (whole rule_target per row)', () => {
  // Rule with no `distribute` key: synthetic _all bucket covers all
  // matched records. Per-row target = full rule_target (NOT divided
  // by matchedCount).
  const plan = makePlan([
    ruleEligible('r1', 'No distribute', 40, {}, {}),
  ]);
  const records = [
    holding('h1', 'TWD', 10, 100),
    holding('h2', 'TWD', 20, 100),
  ];
  const out = computeCandidates(plan, { records, totalValue: 10000, fxRate: FX });
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // rule_target = 4000; each row gets full 4000 (NOT 2000).
  assert.equal(byId.h1.targetValue, 4000);
  assert.equal(byId.h2.targetValue, 4000);
});

test('v1.20: records missing the distribute attribute land in _unassigned (target=0, delta=-current)', () => {
  // 1 record WITH distribute attribute + 1 WITHOUT. distribute covers
  // {US: 100} only. Orphan (no region attr) → _unassigned bucket.
  const plan = makePlan([
    ruleEligible('r1', 'US only', 50, {}, { region: { US: 100 } }),
  ]);
  const records = [
    holding('us1', 'USD', 1, 100, { region: 'US' }),    // 100 USD = 3200 TWD
    holding('orphan', 'TWD', 10, 100, {}),               // 1000 TWD
  ];
  // Total in baseline TWD = 3200 + 1000 = 4200. rule_target = 50% × 4200 = 2100.
  const totalValue = 4200;
  const out = computeCandidates(plan, { records, totalValue, fxRate: FX });
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // Orphan (TWD): in _unassigned bucket, target=0, delta=-current (=-1000 TWD).
  assert.equal(byId.orphan.targetValue, 0);
  assert.equal(byId.orphan.delta, -1000);
  // us1 (USD): bucket_target = 100% × 2100 = 2100 TWD → 2100/32 = 65.625 USD.
  // Back-converted to USD for the per-record native currency field.
  assert.equal(byId.us1.targetValue, 2100 / FX);
});

test('v1.20: per-row deltaShares uses the record’s current_price (not a fixed value)', () => {
  // Same bucket, 2 TW records with different prices: each row’s
  // deltaShares = bucket_delta / row’s current_price (so the user can
  // pick any row and the per-share math stays correct). v1.20.1 fix:
  // this is what the comment has always said; the asserts now match.
  const plan = makePlan([
    ruleEligible('r1', 'TW only', 30, {}, { region: { TW: 100 } }),
  ]);
  const records = [
    holding('tw1', 'TWD', 100, 100, { region: 'TW' }), // 10k current
    holding('tw2', 'TWD', 100, 200, { region: 'TW' }), // 20k current, different price
  ];
  const out = computeCandidates(plan, { records, totalValue: 100000, fxRate: FX });
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));
  // rule_target = 30k. Bucket current = 30k. Bucket delta = 0.
  // Per-row targetValue = bucket_target = 30k (NOT divided).
  assert.equal(byId.tw1.targetValue, 30000);
  assert.equal(byId.tw2.targetValue, 30000);
  // v1.20.1: deltaShares = bucket_delta / price = 0 / price = 0 for both
  // (bucket is exactly at target — neither buy nor sell).
  assert.equal(byId.tw1.deltaShares, 0);
  assert.equal(byId.tw2.deltaShares, 0);
});

// ---- v1.20 close-out: bucket targets shared with Home (ADR 0026 §1) ----

test('v1.20 close-out: per-row Target $ = bucket target back-converted to each row’s native currency', () => {
  // Locks the Rebalance side of the cross-surface invariant: each
  // row's targetValue (in native currency) is the bucket_target (TWD)
  // back-converted to the row's currency. The bucket_target comes
  // from Plan.bucketTargetsForRule (the same helper Home's
  // driftForRule consumes); if Rebalance drifts from the helper, this
  // test fails. Mirrors the structural assertion in
  // tests/rebalance-parity.test.js.
  const plan = makePlan([
    ruleEligible('r1', 'US bucket', 30, {}, { region: { US: 100 } }),
  ]);
  // 1 USD record (1k USD = 32k TWD) + 1 TWD-currency record (5k TWD)
  // both tagged US. totalValue (baseline TWD) = (1k + 5k) × FX = 192k.
  // rule_target = 30% × 192k = 57.6k TWD; bucket target = 100% × 57.6k = 57.6k TWD.
  const records = [
    holding('us_usd', 'USD', 10, 100, { region: 'US' }), // 1000 USD = 32000 TWD
    cash('us_twd', 'TWD', 5000, { region: 'US' }),       //  5000 TWD
  ];
  const totalValue = (1_000 + 5_000) * FX;
  const out = computeCandidates(plan, { records, totalValue, fxRate: FX });
  const byId = Object.fromEntries(out[0].matchedRecords.map(c => [c.recordId, c]));

  // bucket_target = 57.6k TWD; back-converted to each row's native currency.
  // us_usd: 57600 / FX = 1800 USD; us_twd: 57600 TWD.
  assert.equal(byId.us_usd.targetValue, 57_600 / FX);
  assert.equal(byId.us_twd.targetValue, 57_600);
});
