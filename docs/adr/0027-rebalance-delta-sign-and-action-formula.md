# 0027 — Rebalance: Δ sign symmetry and per-row Action = bucket_delta / price

## Status

Accepted (v1.20.1)

## Context

Two related display-and-formula defects surfaced on the v1.20
Rebalance page (after [ADR 0026](0026-rebalance-bucket-target-display.md)
shipped bucket-aware per-row targets):

### 1. Δ column negative values rendered without a sign

The Δ cell on the Rebalance candidate row uses an inline Alpine
expression to format the bucket delta in native currency with compact
suffix. The expression was:

```html
x-text="(record.delta && record.delta.deltaValue >= 0 ? '+' : '')
       + formatAmountNative(Math.abs(record.delta.deltaValue), record.currency)"
```

This renders positive deltas as `+$X.XX` (emerald) but negative deltas
as bare `$X.XX` with no sign at all — only the colour tells the user
"this is negative." Reading at a glance is harder than it needs to be,
and the colour-blindness concern aside, it diverges from the
Action-cell convention which uses `+` and U+2212 (`−`) on both sides.
A user with the screenshot's 現金 bucket over-allocated by $67.79W
sees `$67.79W` (red, no sign) where they should see `−$67.79W` (red,
explicit sign).

### 2. Per-row Action used (bucket_target − record_current) / price for holdings

The original `_buildCandidateRecord` computed the per-row holding
Action as `targetShares − currentShares`, where `targetShares =
bucket.target / current_price` is the **full bucket target expressed
in this row's share count**. For a single-record bucket this is
identical to `bucket.delta / current_price` and works correctly. For a
multi-record bucket it does not — every row in the bucket is told
"you should grow to the full bucket target", so executing on **all**
rows overshoots by a factor of `matchedCount`. The screenshot's 國內
bucket (00631L.TW + 00675L.TW, over-allocated by $324.85W) is the
canonical example: both rows say BUY (green, `+36.57L` and `+4.48L`),
even though the bucket is over-allocated and the correct advice is
SELL on each.

The user noted this asymmetry — the Δ column is red (over-allocated)
but the Action cell is green (BUY) — which is the visible signature
of the bug.

## Decision

### (1) Add `formatRebalanceDeltaText` and `formatRebalanceDeltaClass` to `lib/format.js`

Both sides of the sign axis get an explicit sign character:

```js
formatRebalanceDeltaText(value, currency, fxRate) →
  value ≥ 0  → '+' + formatAmount(value, currency, currency, fxRate)
  value  < 0 → '\u2212' + formatAmount(|value|, currency, currency, fxRate)
  value == 0 → '+$0.00'  (positive form; class is slate-400)
```

```js
formatRebalanceDeltaClass(value) →
  value == 0 → 'text-slate-400'
  value  > 0 → 'text-emerald-600'
  value  < 0 → 'text-rose-600'
```

These mirror the existing `formatRebalanceActionText` /
`formatRebalanceActionClass` helpers so the seam is consistent —
both helpers take a numeric value + currency + fxRate (or just a value
for the class-only helper), produce a compact-suffix string, and the
class helper maps sign → Tailwind colour.

Both are exported on `root` (browser globals) AND on `module.exports`
(Node tests) per the existing `lib/format.js` pattern.

### (2) Change holding Action in `_buildCandidateRecord` to `bucket.delta / current_price`

```js
// lib/rebalance.js _buildCandidateRecord (holding branch)
const targetShares = currentPrice > 0 ? targetNative / currentPrice : 0; // unchanged
const deltaShares  = currentPrice > 0 ? deltaNative  / currentPrice : 0; // was: targetShares - currentShares
```

`targetShares` is kept (for display: each row shows "what my value WOULD
be if I carried the full bucket target") but `deltaShares` is now the
**bucket delta expressed in this row's share count**, not the
`target − current` for the row.

Per-record invariant: `deltaShares × current_price === bucket.delta`
(in TWD baseline). Executing the Action on **any one row** in the bucket
fully closes the bucket delta — the user picks which row based on
their preference (cheaper stock vs more diversified, etc.). Executing
on **multiple rows** still overshoots, but that was already the v1.20
limitation (and matches the existing UX promise that the user picks
ONE row per bucket).

### (3) Update `portfolio.html` Delta cells (desktop table + mobile card)

Replace the inline ternary expressions in both the desktop `<td>` and
the mobile card `<div>` with calls to the new helpers. This is a
template-only refactor — no Alpine state changes, no behaviour changes
beyond the sign fix.

## Consequences

### What this buys

- **Δ sign symmetry**: matches the Action cell's `+/−` convention, so
  reading direction is uniform across the Rebalance row.
- **Per-row Action semantics**: every row in a bucket says the same
  thing (sell/buy), with magnitudes calibrated so any single
  execution closes the bucket. No more "every row says BUY when the
  bucket is over-allocated."
- **Cleaner seam**: the Δ column formatting now lives in `lib/format.js`
  with unit-test coverage, mirroring the Action-cell pattern. The
  inline Alpine ternary is gone — fewer places to drift.

### What this changes

- **Holding `deltaShares` semantics**: any caller that read
  `deltaShares` as "shares to add to reach this row's own bucket target"
  will see a different number. The new semantics are "shares to add to
  close the bucket delta when applied to this row." Existing unit
  tests at `tests/rebalance.test.js` that locked in the old formula
  are updated; existing browser tests use single-record buckets (where
  old and new formulas agree), so they're unaffected.
- **Per-record direction can diverge from per-bucket direction in
  edge cases**: when bucket delta exceeds an individual record's value
  in the over-allocated direction, the action would require
  short-selling the row. The user picks a different row instead.
  This matches the v1.20 design ("user picks which row"), and the
  bucket direction is the one that matters for the overall rebalance
  goal.

### What this does NOT change

- Cash Action (`deltaAmount`) — cash has no "price" so the formula
  `bucket.delta` is unchanged.
- Bucket-target display (`targetValue`) — same as v1.20 ADR 0026.
- Rule-level fields (`targetValue`, `currentValue`, `delta`) on the
  rule section header — same as v1.20.
- Plan eligibility / `show_in_rebalance` toggle — unchanged.

## Test coverage

### Unit (`tests/rebalance.test.js`)

Two new tests capture the screenshot's 00631L + 00675L scenario
(2-record over-allocated bucket → per-row Action = bucket.delta /
price, executing either row closes the bucket) and the symmetric
under-allocated case. Three existing tests that locked in the old
formula are updated; their assertions now reflect the new semantics,
and the existing v1.20 close-out test (`per-row targetValue = bucket
target`) gains a comment noting the formula change.

### Unit (`tests/format.test.js`)

Seven new tests cover `formatRebalanceDeltaText` and
`formatRebalanceDeltaClass`: positive/negative/zero in both USD and
TWD, the U+2212-vs-U+002D contract (negative uses U+2212, not ASCII
hyphen, matching the Action cell), and defensive handling of non-finite
values.

### Browser (`tests/browser/rebalance.spec.js`)

Three new browser tests:
- Δ cell with negative bucket delta renders `−$X.XX` (rose-600).
- Δ cell with positive bucket delta renders `+$X.XX` (emerald-600).
- 2-record holding bucket: both rows render `−$55.00W` (shared
  bucket Δ) with per-row Actions of `−5.50L` and `−0.55L` (different
  per-row shares, calibration that closes the bucket when applied to
  either row alone).

## Related

- [ADR 0017 — Rebalance advisor](0017-rebalance-advisor.md) (original
  v1.8 design)
- [ADR 0026 — Per-row bucket target display](0026-rebalance-bucket-target-display.md)
  (v1.20 close-out that introduced the bucket-level Δ semantics this
  ADR extends to the share-count Action formula)
- `.scratch/v1.20.1-delta-sign-and-action-formula/` — implementation
  notes and review thread
