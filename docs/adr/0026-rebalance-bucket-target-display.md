# 0026 — Rebalance: per-row bucket target display (no division by record count)

## Status

Accepted (v1.20)

## Context

[ADR 0017 §4](0017-rebalance-advisor.md#4-even-split-of-target-value-across-matched-records-per-record-candidate-rows)
establishes that the v1.8 Rebalance advisor computes a per-rule
`target_value = total_portfolio_value × target_weight_pct`, then
**even-splits it across N matched records** — each candidate row's
`targetValue` is `target_value / matchedCount`. This was the simplest
extension that produced a useful per-record row, but it ignored the
rule's `distribute` weights.

[ADR 0017 §131 "Negative / known limitations"](0017-rebalance-advisor.md#negative--known-limitations)
explicitly reserves the "per-leaf weights" extension for a later
version (first bullet):

> Even-split is the only within-leaf policy. Users who want "70/30
> within my TW sleeve" must add per-leaf weights (v1.8.x). v1.8 ships
> the simplest model that satisfies the user's example.

That "when" is now. The user has reported a real bug: **the Rebalance
page's per-row `Target $` does not match the Home page's per-bucket
`Target $`** for the same rule. The mismatch grows large when a rule's
`distribute` weights and the actual bucket counts disagree (e.g.
`distribute {region: {US: 75, TW: 25}}` but the rule matches 1 US record
and 4 TW records — pre-v1.20 Rebalance shows TW `Target $` 4× too high
and US 4× too low). The user's invariant:

> the target value in rebalance card's every row should equal to the
> value of the same rule in home page's Plan vs Actual card. ... if
> there are many holdings in the bucket, the target value of every
> holding is same with the target value in home page, don't need to
> divid by number of holding.

This ADR ships the per-leaf weights extension and rewrites the
per-record target computation. It does not change rule schema, the
Home-side bucket math (already bucket-aware per ADR 0024), or the
rebalance UI rendering (UI changes in T02 land separately).

## Decisions

### 1. Per-row target = bucket target (NOT divided by record count)

For each rule with `distribute` (one target category, K value_ids):

```
bucket_target_twd  = rule_target_twd × distribute_weight[vid] / 100
bucket_current_twd = Σ toTWD(rec.value, rec.currency, fxRate) over recs in bucket
bucket_delta_twd   = bucket_target_twd − bucket_current_twd
```

Each record's per-row `targetValue` and `delta` (back-converted to
native currency) **equal the bucket target / delta**, not those divided
by `matchedCount`. The user picks which record(s) within the bucket to
actually execute.

This aligns Rebalance with Home's `target_amount[value_id]` (ADR 0024
§3). Same dollar number on both surfaces for the same holding category
— the user's stated trust/consistency invariant.

### 2. Delta sign matches the action direction

Rebalance's per-row `delta = target − current` is **positive when the
bucket needs to buy more** and **negative when it needs to sell**. This
is the opposite sign of Home's `drift_amount = actual − target`
(positive = over-allocated), but the two surfaces serve different
purposes: Rebalance's sign aligns with the action direction in the
Action cell (positive → buy, negative → sell); Home's sign aligns with
the drift metaphor ("you're drifting above target"). The two
conventions are reconciled in plain language on each surface, not by
coercing one to match the other.

### 3. No-distribute fallback: synthetic `_all` bucket

Rules with no `distribute` (rare — most rules have one) fall back to a
synthetic `_all` bucket with weight 100% (= the whole rule). Per-row
`targetValue` = full `rule_target` (NOT divided by matchedCount).
Consistent with §1's principle ("never divide by record count").

For rules with `distribute` that contains a single value_id at 100%
weight (e.g. `distribute {type: {stock: 100}}`), the same principle
applies: the bucket is "all stocks", per-row target = full rule_target.
This is a deliberate behaviour change from v1.8 (where even-split
divided by matchedCount), but matches the user's invariant.

### 4. Records missing the distribute attribute → synthetic `_unassigned` bucket

Matched records that lack the rule's distribute attribute (e.g. a stock
holding without a `region` attribute when the rule's distribute is
`{region: {US: 75, TW: 25}}`) are placed in a synthetic `_unassigned`
bucket with **weight = 0** and **target = 0**. Their per-row
`targetValue` is 0; their per-row `delta` is `-current` (= "reduce to
zero to satisfy the bucket"). They still appear in `matchedRecords`
so the user can see and act on them (typically: tag them or remove
them).

This is a pragmatic default. Edge case: if the user sees friction
(their plans frequently leave records without the distribute attribute),
a future ADR can change the default to "redistribute unassigned value
across buckets proportionally to their weight" or "ignore unassigned
from the bucket sum entirely". For v1.20, the default matches Home's
behaviour (ADR 0024 §4: unassigned records excluded from the bucket
sum, drift_amount = -target_amount per distribute value_id when all
matched records are unassigned).

### 5. Schema unchanged

`rule.distribute` shape unchanged (it was already `{[cat]: {[vid]: weight}}`).
No new fields. Schema version stays at `'1.1'` per ADR 0009 §6
(additive field doesn't bump version; v1.20 isn't even additive — it's
a derived-view algorithm change).

### 6. `computeTotalDrift` unchanged

The rule-level `drift = Σ |delta|` (sum of bucket deltas = sum of
`rule_target - rule_current`) is unchanged. v1.20 only changes how the
delta is distributed across per-record rows; the rule-level sum is
the same number (assuming all matched records land in a real bucket
or in `_unassigned`).

### 7. UI rendering changes live in a separate ticket

The Rebalance page's Action cell format and colour (T02) change
separately. v1.20's algorithm change does NOT depend on T02 (T02
just formats the new per-row `delta` and `deltaShares` values), and
T02 does NOT depend on anything beyond this ADR. The two ship
together for UX consistency but are independent code changes.

## Consequences

- **Test changes**: 6 existing even-split tests in
  `tests/rebalance.test.js` are updated to expect the new per-row
  target semantics. 6 new regression tests added in
  `tests/rebalance-parity.test.js` (covering user's reported scenario,
  mixed-currency buckets, unassigned records, single value_id 100%
  with N records, all-in-one-bucket, and the historical accidental
  parity case).
- **Behaviour change visible to the user**: pre-v1.20 rules with
  multiple matched records and a single value_id 100% distribute will
  now show the full bucket target on every row (not target / N). The
  user picks which row(s) to execute. This is the user's stated
  intent; documented here so a future reader doesn't mistake it for a
  regression.
- **No schema migration**: existing `portfolio_rebalance.json` files
  work unchanged.
- **Backwards compatibility for Home**: Home's `driftForRule` already
  uses bucket-aware math (ADR 0024). This ADR doesn't touch Home; it
  brings Rebalance into the same model.

## Implementation

- `lib/rebalance.js`: new `_splitTargetsByBucket(rule, matched,
  ruleTargetTwd, fxRate)` helper returning
  `{ targetCatId, buckets: {[vid]: {target, current, delta}},
    unassigned: {target, current, delta} | null }`. `_buildCandidateRecord`
  rewritten to take `bucketTargetTwd` + `bucketDeltaTwd` (replacing
  even-split path). `computeCandidates` iterates records and looks up
  the right bucket per record's distribute attribute (or `_unassigned`
  if missing). Rule-level `targetValue`/`currentValue`/`delta` are
  unchanged (still whole-rule sum in baseline TWD).
- `tests/rebalance.test.js`: 6 even-split tests updated.
- `tests/rebalance-parity.test.js` (NEW, renamed from the v1.20
  red-cap probe): 6 regression tests.

## References

- [ADR 0017](0017-rebalance-advisor.md) — v1.8 rebalance advisor,
  §4 even-split (the policy this ADR replaces) and §131 the per-leaf
  weights extension point this ADR ships.
- [ADR 0024](0024-home-plan-amounts.md) — Home Plan vs Actual amounts
  (already bucket-aware; the model this ADR aligns Rebalance with).
- [ADR 0025](0025-rule-show-in-rebalance-toggle.md) — the
  `show_in_rebalance` gate that runs before this algorithm.
- [ADR 0021](0021-act-vs-measure.md) — `formatAmountNative` for
  per-record currency formatting used downstream.
- [ADR 0009 §6](0009-multi-record-plans-schemas-and-migration.md#6-additive-fields-dont-bump-schema-version) —
  additive fields don't bump schema; v1.20 is an algorithm change so
  this is doubly safe.