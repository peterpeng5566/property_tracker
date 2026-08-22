// tests/rebalance-parity.test.js — cross-surface parity invariant
//
// Pre-v1.20-close-out this file held 4 cross-surface parity tests
// that compared Home driftForRule.target_amount[vid] to Rebalance
// computeCandidates's per-row targetValue (back to TWD). The
// invariant ("same dollar on both surfaces", ADR 0024 §3 + ADR 0026
// §1) is now structurally enforced — both surfaces consume
// `Plan.bucketTargetsForRule` from `lib/plan.js`. Per-scenario
// coverage moved to tests/plan.test.js (Slice 14, 3 tests for the
// helper directly + 1 integration test against driftForRule) and
// tests/rebalance.test.js (1 native-currency back-conversion test).
//
// This file remains as a single structural test: one scenario, three
// assertions (helper output = Home target_amount = Rebalance per-row
// targetValue). If any of the three call sites drifts from
// `Plan.bucketTargetsForRule`, this test fails.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { driftForRule, bucketTargetsForRule } = require('../lib/plan.js');
const { computeCandidates } = require('../lib/rebalance.js');

const FX = 32;

// 75/25 distribute with mismatched bucket counts (the user's reported
// v1.20 scenario). Records are TWD-valued (so per-row targetValue is
// already in TWD without back-conversion).
const RULE = {
  id: 'r1', name: 'Parity', target_weight_pct: 30, show_in_rebalance: true,
  when: {},
  distribute: { region: { US: 75, TW: 25 } },
};
const RECORDS = [
  { id: 'us', kind: 'holding', currency: 'TWD', value: 1000, shares: 10, current_price: 100, attributes: { region: 'US' } },
  { id: 'tw', kind: 'holding', currency: 'TWD', value: 1000, shares: 10, current_price: 100, attributes: { region: 'TW' } },
];
const TOTAL = 2000; // baseline TWD; rule_target = 30% × 2000 = 600 TWD

test('PARITY INVARIANT: helper output = Home target_amount = Rebalance per-row target', () => {
  const helper = bucketTargetsForRule(RULE, 600);
  assert.equal(helper.US, 450); // 75% × 600
  assert.equal(helper.TW, 150); // 25% × 600

  const home = driftForRule(RULE, RECORDS, undefined, FX, TOTAL);
  assert.equal(home.target_amount.US, helper.US);
  assert.equal(home.target_amount.TW, helper.TW);

  const cands = computeCandidates({ rules: [RULE] }, { records: RECORDS, totalValue: TOTAL, fxRate: FX });
  const byId = Object.fromEntries(cands[0].matchedRecords.map(c => [c.recordId, c]));
  assert.equal(byId.us.targetValue, helper.US);
  assert.equal(byId.tw.targetValue, helper.TW);
});