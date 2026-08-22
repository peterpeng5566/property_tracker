// tests/rebalance-parity.test.js — permanent regression for v1.20
// bucket-aware Rebalance target display (ADR 0026).
//
// User invariant: for every distribute value_id bucket, each Rebalance
// candidate row's `targetValue` (back-converted to baseline TWD) MUST
// equal the corresponding Home driftForRule `target_amount[value_id]`.
// Same dollar number on both surfaces for the same holding category.
//
// This file holds the *cross-surface parity* tests (comparing
// Rebalance output to Home driftForRule output). Algorithm-only
// edge cases (no-distribute fallback, unassigned records, single
// value_id 100%, etc.) live in tests/rebalance.test.js where they
// sit alongside the rest of the lib's unit tests.
//
// Replaces the v1.20 red-cap probe at tests/_redcap_target_parity.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { driftForRule } = require('../lib/plan.js');
const { computeCandidates } = require('../lib/rebalance.js');
const { toTWD } = require('../lib/format.js');

const FX = 32; // 1 USD = 32 TWD

function makeRecord(id, currency, value, attributes, kind = 'holding') {
  return {
    id, kind, currency, value, balance: value, shares: 100,
    current_price: currency === 'USD' ? value : value / 100,
    attributes,
  };
}

// Aggregate candidate rows back to per-row TWD values for comparison.
function _perRowTwd(matchedRecs, sourceRecords) {
  return matchedRecs.map(rec => {
    const src = sourceRecords.find(r => r.id === rec.recordId);
    return {
      recordId: rec.recordId,
      attrs: src.attributes,
      targetTwd: toTWD(rec.targetValue, rec.currency, FX),
    };
  });
}

// ---- User's reported scenario: 1 US + 4 TW, distribute 75/25 ----

test('REGRESSION: per-row Target $ = Home bucket target, 1 US + 4 TW, distribute 75/25', () => {
  // The user's reported scenario. Pre-v1.20 the SUM was wrong (1/5 rule_target
  // vs 3/4 rule_target); now each ROW equals Home's bucket target (= 75% /
  // 25% of rule_target). The SUM is intentionally 4× the bucket target for
  // the TW bucket — the user picks which row(s) to execute.
  const rule = {
    id: 'r1', name: 'Stocks', target_weight_pct: 30, show_in_rebalance: true,
    when: {},
    distribute: { region: { US: 75, TW: 25 } },
  };

  // 1 US holding (1M TWD), 4 TW holdings (250k TWD each = 1M TWD).
  // Total TWD = 2M. rule_target = 30% × 2M = 600k TWD.
  const records = [
    makeRecord('us1', 'USD', 32_000, { region: 'US' }),  // 1M TWD
    makeRecord('tw1', 'TWD', 250_000, { region: 'TW' }), // 250k TWD
    makeRecord('tw2', 'TWD', 250_000, { region: 'TW' }),
    makeRecord('tw3', 'TWD', 250_000, { region: 'TW' }),
    makeRecord('tw4', 'TWD', 250_000, { region: 'TW' }),
  ];
  const totalValue = 2_000_000;
  const netWorth = 2_000_000; // no debts

  const homeResult = driftForRule(rule, records, undefined, FX, netWorth);
  const homeUS_target = homeResult.target_amount.US;
  const homeTW_target = homeResult.target_amount.TW;

  const cands = computeCandidates(
    { rules: [rule] },
    { records, totalValue, fxRate: FX },
  );
  const rows = _perRowTwd(cands[0].matchedRecords, records);

  // Per-row Target $ parity. The user's invariant (v1.20 ADR 0026):
  // each row's targetValue (back to TWD) === its bucket's Home
  // target_amount. Note: we don't compare Delta $ across surfaces —
  // Home's `drift_amount = actual - target` (positive = over-allocated)
  // is the inverse sign of Rebalance's `delta = target - current`
  // (positive = buy more). Different semantics by design (ADR 0024
  // vs ADR 0026); Rebalance's sign aligns with the action direction.
  for (const row of rows) {
    const expectedTarget = row.attrs.region === 'US' ? homeUS_target : homeTW_target;
    assert.equal(Math.round(row.targetTwd), Math.round(expectedTarget),
      `${row.attrs.region} row ${row.recordId}: per-row Target $ should equal Home bucket target. ` +
      `got ${row.targetTwd} (Rebalance) vs ${expectedTarget} (Home)`);
  }

  // Spot-check: US bucket target = 450000 (75% × 600000), TW = 150000.
  assert.equal(Math.round(homeUS_target), 450000);
  assert.equal(Math.round(homeTW_target), 150000);
});

// ---- Pre-v1.20 incidental parity: 3 US + 1 TW, distribute 75/25 ----

test('REGRESSION: per-row parity still holds when bucket counts mirror weights', () => {
  // 3 US + 1 TW; distribute 75/25. Bucket counts DO mirror weights.
  const rule = {
    id: 'r1', name: 'Stocks', target_weight_pct: 30, show_in_rebalance: true,
    when: {},
    distribute: { region: { US: 75, TW: 25 } },
  };
  const records = [
    makeRecord('us1', 'USD', 32_000, { region: 'US' }),
    makeRecord('us2', 'USD', 32_000, { region: 'US' }),
    makeRecord('us3', 'USD', 32_000, { region: 'US' }),
    makeRecord('tw1', 'TWD', 1_000_000, { region: 'TW' }),
  ];
  const totalValue = 4_000_000;
  const netWorth = 4_000_000;

  const homeResult = driftForRule(rule, records, undefined, FX, netWorth);
  const cands = computeCandidates(
    { rules: [rule] },
    { records, totalValue, fxRate: FX },
  );
  const rows = _perRowTwd(cands[0].matchedRecords, records);

  for (const row of rows) {
    const homeAmt = homeResult.target_amount[row.attrs.region];
    assert.equal(Math.round(row.targetTwd), Math.round(homeAmt),
      `${row.attrs.region} row ${row.recordId}: Target $ should equal Home bucket target. ` +
      `got ${row.targetTwd} vs ${homeAmt}`);
  }
});

// ---- All same bucket: 5 records all in one bucket ----

test('REGRESSION: per-row parity when all records are in the same bucket (100% weight)', () => {
  // distribute { region: { US: 100 } }: all 5 records US, bucket weight 100%.
  // Per-row Target $ = bucket_target = rule_target (since 100%).
  const rule = {
    id: 'r1', name: 'US only', target_weight_pct: 30, show_in_rebalance: true,
    when: {},
    distribute: { region: { US: 100 } },
  };
  const records = [
    makeRecord('us1', 'USD', 1_000, { region: 'US' }),
    makeRecord('us2', 'USD', 2_000, { region: 'US' }),
    makeRecord('us3', 'USD', 3_000, { region: 'US' }),
    makeRecord('us4', 'USD', 4_000, { region: 'US' }),
    makeRecord('us5', 'USD', 5_000, { region: 'US' }),
  ];
  const totalValue = 15_000 * FX; // baseline TWD
  const netWorth = totalValue;

  const homeResult = driftForRule(rule, records, undefined, FX, netWorth);
  const cands = computeCandidates(
    { rules: [rule] },
    { records, totalValue, fxRate: FX },
  );
  const rows = _perRowTwd(cands[0].matchedRecords, records);

  const homeUS = homeResult.target_amount.US;
  for (const row of rows) {
    assert.equal(Math.round(row.targetTwd), Math.round(homeUS),
      `row ${row.recordId}: Target $ should equal Home US bucket target. ` +
      `got ${row.targetTwd} vs ${homeUS}`);
  }
});

// ---- Mixed-currency bucket: USD and TWD records in the same bucket ----

test('REGRESSION: per-row parity for multi-currency records in same bucket', () => {
  // Bucket US contains 1 USD record + 1 TWD-currency record (treated
  // as US by attribute). Each row's Target $ = bucket_target in NATIVE currency.
  const rule = {
    id: 'r1', name: 'US bucket', target_weight_pct: 30, show_in_rebalance: true,
    when: {},
    distribute: { region: { US: 100 } },
  };
  const records = [
    makeRecord('us_usd', 'USD', 1_000, { region: 'US' }), // 1k USD = 32k TWD
    makeRecord('us_twd', 'TWD', 5_000, { region: 'US' }), // 5k TWD
  ];
  const totalValue = (1_000 + 5_000) * FX;
  const netWorth = totalValue;

  const homeResult = driftForRule(rule, records, undefined, FX, netWorth);
  const cands = computeCandidates(
    { rules: [rule] },
    { records, totalValue, fxRate: FX },
  );
  const rows = _perRowTwd(cands[0].matchedRecords, records);

  const homeUS = homeResult.target_amount.US;
  for (const row of rows) {
    assert.equal(Math.round(row.targetTwd), Math.round(homeUS),
      `row ${row.recordId}: Target $ (TWD) should equal Home US bucket target. ` +
      `got ${row.targetTwd} vs ${homeUS}`);
  }
});