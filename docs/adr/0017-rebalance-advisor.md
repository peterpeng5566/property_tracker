# 0017 — Region-Aware Rebalance Advisor

## Status

Accepted (v1.8)

## Context

v1.4 introduced *Plan rules* (ADR 0013) — `when` filters + `distribute` weights — that let the user express a target allocation and read the *drift* (actual vs target) on Home. v1.4 does NOT answer the second half of the planning loop: given the drift, **what does the user actually buy or sell to close it?**

Closing the loop is a region-aware rebalance advisor. The user thinks in terms of nested buckets ("50% of my stock sleeve should be in TW; 30% of my bond sleeve should be in US; my cash should be 15% of the portfolio") and wants per-record trade advice ("buy 10 shares of AAPL", "sell 5 shares of TSLA", "move $2,000 into a savings account"). The advisor reads the active plan's rules, matches the user's records, and emits a per-rule × per-matched-record candidate list.

The architectural questions this ADR answers are *how* the feature is wired, not *what* the feature is. The user-facing spec is the three tickets (`01–03`) under `.scratch/v1.8-region-aware-rebalance/`. This ADR captures the load-bearing decisions those tickets made and that future change should treat as locked.

The plan-rule data model already exists (ADR 0013) and so does the per-record newer-wins merge pattern (ADR 0004 + 0016). v1.8 extends both additively.

## Decision

### 1. Extend `Plan.rule` with optional `target_weight_pct`

A rule gains one new optional field: `target_weight_pct: number` in `[0, 100]`. When set, the rule is *rebalance-eligible*: the rebalance advisor uses it. When absent (or `null`), the rule remains a *drift-only* rule — exactly the v1.4 behaviour, unchanged.

The field is validated by `Plan.validateRule`: a finite number in `[0, 100]`; otherwise the rule is invalid (and the plan editor prevents saving it). Missing / `null` / `undefined` are not errors — they mean "not rebalance-eligible", which is the safe default for pre-v1.8 plans.

**Rejected**: a new separate `data.rebalance_plans[]` array parallel to `data.plans[]`. Reasons:
- Two parallel data structures means two parallel merge paths, two parallel validation paths, two parallel editor surfaces. The user already has the *plan* as their single source of intent ("here's what I want my portfolio to look like"); the rebalance weights live INSIDE that intent.
- Drift and rebalance share the same filter (`when`) and the same matched records; only the output shape differs. Two structures means two filters / two matchings — duplicate state that can disagree.
- ADR 0009 §6's additive shape (one field on one existing record) is the lowest-risk extension point. A new top-level array is the highest.

**Rejected**: replace the `distribute` field with `target_weight_pct`. The `distribute` field answers "given records matched by `when`, what fraction should each value_id have"; the `target_weight_pct` field answers "how much of my total portfolio should this leaf be". They are independent axes (the former is within-leaf distribution; the latter is leaf-as-a-whole size). Removing either loses a feature the user has. Keeping both extends the rule by one field.

### 2. Use existing Categories as attribute source; no new attribute schema

The advisor reuses `data.categories[]` (ADR 0016) as the attribute system. The user builds the categories they want (`Region` / `AssetClass` / `UnderlyingRegion` / `Sector` / `Liquidity` / etc.) and the rule's `when` filter references them via category ids and value ids. There is **no new attribute type, no new per-ETF field, no new per-portfolio field**.

**Rejected**: per-ETF `underlying_region` field on each holding. Reasons:
- The user's `UnderlyingRegion` is *not* the same as `Region` (an S&P 500 ETF held by a US-resident user might be "Region=US" but "UnderlyingRegion=World"). Two concepts that should not collapse into one field.
- Per-record fields are static; categories can evolve (user adds a new `Liquidity` axis without touching holdings). Categories are the right place for a multi-axis classification.
- The user already builds `Region` and `AssetClass` themselves. Adding `UnderlyingRegion` is one more value-set in the Categories UI; no schema change.

### 3. Cash is a first-class asset class; `kind` is implicit from filter

A rule is implicitly a *cash rule* iff its `when` filter matches only cash accounts (i.e., the user filtered for `AssetClass=Cash` or equivalent — whatever value the user defined for "Cash"). Otherwise the rule is a *holding rule*. The `kind` is determined at compute time by inspecting matched records, not stored as a schema field.

**Rejected**: an explicit `rule.kind: 'cash' | 'holding'` field. Reasons:
- The user's *filter* already declares intent ("I want this leaf to be the cash bucket"). Storing `kind` separately means two parallel declarations that can disagree.
- `kind` is a derived property of `(rule, records)`; the lib computes it deterministically each time the advisor runs. Caching it would require invalidation logic whenever records or filters change.

**Rejected**: hard-coding the user's "Cash" value id. The user's Category values are user-defined; the lib must be agnostic. Cash-ness is detected by `kind === 'cash'` on the record (set by the Alpine shim from `data.cash_accounts` vs `data.holdings`), not by any string match.

### 4. Even-split of target value across matched records; per-record candidate rows

A rule's `target_value = total_portfolio_value × target_weight_pct / 100`. This value is **even-split** across N matched records: each record's `target_value_baseline = rule.target_value / N`. The candidate row's per-record display is in the record's **native currency** (back-converted from baseline via `fromTWD`).

For a holding: `target_shares = target_value_native / current_price`. `action = 'buy' | 'sell'` based on sign of `delta_shares = target_shares - current_shares`.

For a cash account: `target_balance_native = target_value_native`. `action = 'add' | 'reduce'` based on sign of `delta_amount = target_balance_native - current_balance`.

Example (from user Round 4 Q1): leaf needs $200 total; 2 matched holdings at prices $10 and $20, both currently 0 shares. Each gets `target_value_baseline = $100`. Holding 1's `target_shares = $100 / $10 = 10`. Holding 2's `target_shares = $100 / $20 = 5`.

**Rejected**: proportional-to-current-value split. The user's example is unambiguous: they want each holding to reach its OWN target value, not a delta proportional to current weight. Even-split-of-target-value is the rule the user asked for.

**Rejected**: per-leaf weights (the user assigns each holding a weight within the leaf). Adds a `weights[]` array per leaf. The user's R4-Q1 example shows they want the simplest possible model first; per-leaf weights is a future refinement (v1.8.x).

**Rejected**: tolerance band ("don't show if drift is < 5%"). The user explicitly chose "always show" — every rebalance-eligible rule produces candidate rows for every matched record, even if drift is zero. The UI can render zero-drift rows collapsed by default; the lib never silently drops them.

### 5. 0% tolerance: always list every eligible rule × every matched record

No threshold; no "noise filter"; no auto-skip. Every rebalance-eligible rule produces one entry in `computeCandidates` output, and within that entry every matched record becomes a candidate row.

**Rejected**: a `minDriftPct` field on the rule (or globally) below which candidates are hidden. Reasons:
- The user's R2-Q2+Q3 chose "always show". Even when drift is zero, the user wants to see "you are at target" — that's positive feedback, not noise.
- A drift filter would mean the candidate list varies depending on portfolio value at run time, which complicates the "is this a rebalance I want to do?" question.

### 6. Per-region native currency for trade advice; baseline currency for total drift %

Each candidate row's `currentValue`, `targetValue`, `delta` is in the record's **native currency** (USD / TWD / etc.). The rule header's `targetValue` / `currentValue` / `delta` and the page-level `computeTotalDrift(...).drift` are in the **baseline currency** (`settings.display_currency`, default TWD).

The dual display reflects two questions:
- "How much drift in my baseline currency?" → page header in baseline.
- "How many shares of this USD-listed holding should I buy?" → candidate row in USD.

**Rejected**: always-baseline display. Forces every user to mentally translate USD amounts back to TWD before they can act on the trade. The user's broker app shows USD holdings in USD; the advisor should too.

**Rejected**: always-native display. The "total drift %" line has no native currency (it's an aggregate); baseline is the only sensible default.

### 7. Multi-rule co-collision = independent rows

When N rebalance-eligible rules match the same holding, the advisor emits **N candidate rows** for that holding — one per rule. Each row carries that rule's `target_value` and `target_shares`; the user picks which to execute. The lib does NOT attempt to reconcile or split.

**Rejected**: auto-distribute the holding's value across matching rules. Reasons:
- The user's R4-Q1 example was explicitly about even-split *within* a leaf (one rule → many holdings). Cross-leaf co-collision is a different problem with no obvious right answer.
- Auto-distribute hides the conflict from the user. They edit a rule, the advisor silently changes which rule "owns" the holding, and the user doesn't understand why their plan's behaviour changed.
- Showing all rows makes the conflict visible. The user either resolves it (delete one rule, change filters, accept the duplicate) or accepts the cost.

**Rejected**: deduplicate identical (rule_id, record_id) pairs. There is no such pair — each pair is unique by construction. The "collision" is between distinct rule_ids matching the same record_id.

### 8. Category-row builder as filter UI

The Plan editor's rule filter UI is extended to N rows of `Category ▶ value(s)`. Each row combines by AND (across rows) and OR (within a row). Users add / remove rows. Existing single-row filters keep working for users who don't rebalance.

**Rejected**: replace the existing filter UI with a full Boolean-expression editor. Reasons:
- The existing rule `when` shape is `{categoryId: [valueId, ...]}` — a multi-row AND-of-OR-clauses by construction. The UI was just rendering the first row only. Rendering all rows is the minimal extension; a full expression editor is a UX redesign.
- The user's mental model is "I want records that match all of these axes". The row builder maps 1:1 to that mental model. A Boolean expression editor (with NOT / parentheses / etc.) introduces surface area the user almost never wants.

### 9. Schema stays at `'1.1'`; rule-field merge path is the existing per-record newer-wins

Both changes are additive at the field level: `rules[].target_weight_pct`. The merge behaviour change (per-rule newer-wins includes the new field) lives in `lib/sync.js` — but no new merge code is needed; the existing `mergeByIdWithDeletions` on `data.plans[]` already covers `target_weight_pct` because the rule is the merge unit (per ADR 0004 + 0016). When a plan's `updated_at` is newer, the entire plan object (including all rules and all rule sub-fields) replaces the older plan.

Pre-v1.8 plans (no `target_weight_pct`) load into v1.8 cleanly:
- The validator accepts the absence (rule remains drift-only).
- The advisor skips rules without `target_weight_pct` (no eligibility).
- No schema version bump.

**Rejected**: per-field newer-wins for `target_weight_pct` alone. Reasons:
- The rule is the merge unit. Sub-fields merge as part of the rule.
- Per-field merging would mean a separate `updated_at` per rule sub-field, doubling the merge bookkeeping. The rule's `updated_at` already reflects "this rule changed in any way" (the editor stamps it on any rule edit per ADR 0013).

**Rejected**: bump to `'1.8'`. False signal that migration code is needed. ADR 0009 §6 says additive fields don't bump. `data.version` stays `'1.1'`.

## Consequences

### Positive

- The planning loop is closed: the user can now answer "what should I actually do to get on plan?" in one click on the Rebalance page.
- The advisor reuses the plan data model + category system + sync primitives; no new infrastructure. The implementation is one new `lib/rebalance.js` (~150 lines) plus one new nav page (`portfolio.html`).
- Even-split-of-target-value is the simplest possible within-leaf policy. Users who want more sophisticated splits (per-leaf weights, per-record weights) have a clear extension point — add a `weights: number[]` field on the rule (v1.8.x).
- Schema stays at `'1.1'`; pre-v1.8 plans and pre-v1.8 categories both load into v1.8 unchanged.
- The advisor's output is independent of sync (it's a read-only view of local state + active plan). Sync only matters for the rule's `target_weight_pct` field, which uses the existing per-record newer-wins path.

### Negative / known limitations

- **Even-split is the only within-leaf policy**. Users who want "70/30 within my TW sleeve" must add per-leaf weights (v1.8.x). v1.8 ships the simplest model that satisfies the user's example.
- **Multi-rule co-collision is noisy**. A holding matched by 3 rules shows up 3 times. Users with overlapping rules must either accept the noise or restructure their filters.
- **Lot-size is deferred**. The user's R2-Q1 deferred lot-size enforcement to v1.8.x. v1.8 shows fractional shares; the user's broker may differ.
- **Cash residual destination is manual**. When a holding row says "sell N shares", the proceeds land in *some* cash account. v1.8 doesn't auto-route; the user picks the destination cash account manually (or accepts the default). A simple default-destination rule is v1.8.x.
- **Rebalance uses live prices only**. No snapshot-vs-snapshot rebalance. Live prices are the user's "now" question.
- **Tolerance is 0%.** The page shows every candidate, including drift = 0. UI may render zero-drift rows collapsed by default; the lib emits them all.
- **Per-currency total drift is not displayed**. The page header is baseline-only; per-region drift subtotals are deferred.
- **No per-record `kind` validation**. The caller (Alpine shim) is responsible for tagging records with `kind: 'holding' | 'cash'`. A record without `kind` is treated as a holding by default.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Additive `target_weight_pct` on `Plan.rule` (not new structure) | One new field per rule; minimal schema change; reuses drift infra |
| Even-split-of-target-value (no per-leaf weights) | Simplest model that matches user example; per-leaf weights is v1.8.x |
| Implicit `kind` from filter (not stored) | Filter already declares intent; no duplicate state; derived at compute time |
| Always list every candidate (0% tolerance) | Page is verbose; user gets positive feedback ("on target") for free; UI can collapse zero-drift rows |
| Native currency per row, baseline per total | Two currencies on screen; matches the user's two questions (act / measure) |
| Multi-rule co-collision = independent rows | Visible conflict; user resolves; no auto-distribute magic |
| Category-row builder for filter UI | Extends existing filter UI; no Boolean-expression editor; matches user's mental model |
| Schema stays at `'1.1'` | No version bump despite UI surface change; relies on ADR + docs |
| Per-record newer-wins (rule is the merge unit) | Existing merge contract; no new merge code; rule sub-fields merge atomically |

## Alternatives considered

- **New `data.rebalance_plans[]` array** — parallel data structure; two filters / two matchings; duplicate state. Rejected (§1).
- **Replace `distribute` with `target_weight_pct`** — loses within-leaf distribution; the two axes are independent. Rejected (§1).
- **Per-ETF `underlying_region` field** — static; one-axis only; categories already multi-axis. Rejected (§2).
- **Explicit `rule.kind` field** — duplicate declaration; derived property. Rejected (§3).
- **Hard-coded "Cash" value id** — couples the lib to the user's vocabulary. Rejected (§3).
- **Proportional-to-current-value split** — conflicts with user example. Rejected (§4).
- **Per-leaf weights** — adds a `weights[]` array; v1.8 ships simpler. Deferred (§4).
- **Tolerance band / `minDriftPct`** — user explicitly chose always-show. Rejected (§5).
- **Always-baseline currency display** — USD user has to mentally translate. Rejected (§6).
- **Always-native currency display** — total drift has no native currency. Rejected (§6).
- **Auto-distribute across colliding rules** — hides conflict from user; no obvious right answer. Rejected (§7).
- **Full Boolean expression editor** — UX redesign; the row builder is sufficient. Rejected (§8).
- **Per-field newer-wins for `target_weight_pct`** — duplicate state; rule is the merge unit. Rejected (§9).
- **Bump schema to `'1.8'`** — false signal; ADR 0009 §6 says no. Rejected (§9).

## References

### Internal

- [ADR 0004 — Per-record timestamp merge](0004-per-record-timestamp-merge.md) — per-record newer-wins is the merge primitive for plans and their sub-fields
- [ADR 0009 §6](0009-v1.1-price-tracking.md#6-additive-fields) — additive fields don't bump schema (basis for staying at `'1.1'`)
- [ADR 0013 — Target allocation plans](0013-target-allocation-plans.md) — `Plan.rule` schema + drift math + active plan pointer (§11 added in v1.8 cross-references this ADR)
- [ADR 0016 — Categories + Settings sync](0016-categories-and-settings-sync.md) — categories attribute system + per-record merge for `data.plans[]` siblings
- [`CONTEXT.md`](../../CONTEXT.md) — glossary entries for *Rebalance* / *Rebalance-eligible rule* / *Candidate action* / *Rebalance target value* / *52-week position* (T03)
- [`lib/plan.js`](../../lib/plan.js) — `recordsMatchingRule` predicate reused by `lib/rebalance.js`; `validateRule` extended for `target_weight_pct`
- [`lib/format.js`](../../lib/format.js) — `toTWD` / `fromTWD` for baseline conversion
- [`lib/rebalance.js`](../../lib/rebalance.js) — new pure module: `computeCandidates`, `computeTotalDrift`, `executeCandidate`
- [`portfolio.html`](../../portfolio.html) — Alpine shim wraps `lib/rebalance.js` (Rebalance nav page; T02); `<script>` tag added in T01
- [`tests/rebalance.test.js`](../../tests/rebalance.test.js) — new unit tests for `lib/rebalance.js`
- [`tests/plan.test.js`](../../tests/plan.test.js) — extended with `target_weight_pct` validation tests
- [`tests/sync.test.js`](../../tests/sync.test.js) — extended with `target_weight_pct` merge tests
- [`tests/browser/`](../../tests/browser/) — new `rebalance.spec.js` (T02) for integration scenarios

### Wayfinder decisions

This ADR captures grilled decisions Q1–Q16 from `.scratch/v1.8-region-aware-rebalance/map.md`. Rounds 1–4 settled the taxonomy / cash role / Plans fate / lot-size / tolerance / UI nav / tree shape / extension-vs-replacement / single cash leaf / filter UI / within-leaf delta / kind detection / multi-rule collision. Implementation tickets T01 (data + ADR + tests), T02 (UI + browser integration), T03 (glossary + README + close-out) are filed at `.scratch/v1.8-region-aware-rebalance/issues/`.
