# 0024 — Home Plan vs Actual Amount Columns

## Status

Accepted (v1.17)

## Context

v1.4 introduced Home's "Plan vs Actual" drift section ([ADR 0013](0013-target-allocation-plans.md)): each rule shows its `target%`, `actual%`, and `delta%` per value_id in a 4-column table. v1.8 added the optional `target_weight_pct` field on Plan rules ([ADR 0017](0017-rebalance-advisor.md)) — but the field only fed the Rebalance page; Home kept showing percentage-only drift, leaving users to mentally translate "I'm 5pp under-target on TW stocks" into "I should buy about NT$X more of TW stocks." The user has asked for amount-based drift alongside the existing percentage drift, so they can read both signals side by side.

The architectural questions this ADR answers are about *how* the amount columns are computed, displayed, and coloured — not *what* the feature is. The user-facing spec is the three tickets (`01–03`) under `.scratch/v1.17-home-plan-amounts/`.

The plan data model already exists (ADR 0013, with the v1.8 extension per ADR 0017 §1); the drift math already exists (`lib/plan.js` `driftForRule`); the per-record newer-wins sync path covers the new field without modification. v1.17 extends the lib's *return shape* and the Home Alpine shim's *rendering*, not the rule data model.

## Decision

### 1. Net Worth as the basis for `rule_target_amount`

The `rule_target_amount` (in baseline TWD) is computed as `netWorth × effective_target_weight_pct / 100`, where `netWorth` is `Calc.netWorth(holdings, cash_accounts, debts, displayCurrency, fxRate)` — the same call that Home's existing summary uses to render "Net Worth."

**Rejected**: Rebalance's `holdings + cash` baseline (per ADR 0017 §4). Reasons:
- Home's mental model is "net worth = my portfolio." Using a smaller basis (holdings + cash) would mislead users with debts: the rule's `target$` would silently exclude the debt's contribution, breaking the mental link between "this is my rule" and "this is what my portfolio should look like."
- Home is a *summary* view; Rebalance is an *execution* view. They can have different bases without contradicting each other. The Rebalance page already displays its own total (`computeTotalDrift`) in the same baseline; Home is a different display surface.
- Negative net worth (large debt > holdings + cash) is allowed and renders as a negative `rule_target_amount` — a loud "your plan is broken" signal. Clamping to 0 would hide this. ADR 0024 §2 documents this as intentional.

### 2. Treat missing `target_weight_pct` as 100% on Home

When `rule.target_weight_pct` is missing / `null` / `undefined`, the Home page treats it as `100%` for the `rule_target_amount` computation. Pre-v1.8 plans (which never had the field) thus retroactively show "this rule claims the full portfolio within its `distribute` weights" — a per-leaf-percentage view the user can use to read drift against their existing v1.4 plans.

**This is intentionally different from Rebalance (ADR 0017 §1).** Rebalance's `_isEligible(rule)` predicate treats missing as "not rebalance-eligible" (no candidate rows emitted). Home treats missing as 100% (`rule_target_amount = netWorth`, `target_amount[vid]` filled in via `distribute`). Same field, different semantic per surface, documented.

**Rejected**: requiring a `target_weight_pct` migration (backfilling 100 on every existing rule). Reasons:
- The semantic is *contextual*: the same rule can mean "I'm checking my drift against this 100% allocation" on Home and "I have no rebalance intent" on Rebalance. Forcing a single value loses this expressiveness.
- A migration would write `target_weight_pct: 100` to every rule, breaking Rebalance's "missing = not eligible" check downstream. The migration would need to skip rules where the field is intentionally absent — exactly the case where the user has explicitly chosen drift-only.

**Rejected**: a separate "Home target weight" field parallel to `target_weight_pct`. The user's mental model is "this is one rule"; parallel fields would diverge. The contextual default (missing = 100 on Home, missing = not-eligible on Rebalance) keeps the rule data model unchanged while letting each surface interpret the field as its design requires.

### 3. Display currency = Settings `displayCurrency`

The `$` columns render in `settings.displayCurrency` (the same as Home's Net Worth summary). The lib returns amounts in baseline TWD; the Alpine shim converts TWD → displayCurrency via the existing `formatAmount(twd, 'TWD')` shim.

**Rejected**: per-record native currency (the pattern ADR 0021 uses for Rebalance). Reasons:
- Home is a single-page summary view; per-row native currency would force the user to mentally convert N currencies to add them up — defeating the "show me my drift as money" purpose.
- The user already has `settings.displayCurrency` as a portfolio-wide choice. Following it on Home keeps the mental model: "all the money on this page is in my chosen display currency."
- Rebalance's per-row native pattern (ADR 0021) exists because the candidate row IS the trade advice ("buy 10 shares of AAPL at $150"), and the user wants to act in the record's native currency. Home's drift section is informational, not actionable — it just reports the money impact.

### 4. Shared `drift_class` between `delta%` and `delta$` columns

The 5pp threshold from the existing v1.4 logic (`text-emerald-600` if `|delta%| ≤ 5`, else `text-red-600 font-semibold`) governs both `delta%` and `delta$` cells. Single source of truth; one magic number to tune.

**Rejected**: a separate `$` threshold (e.g., `|delta$| > 5% of net worth → red`). Reasons:
- Two thresholds means two magic numbers; the 5pp threshold is the one that's already pinned by the v1.4 test contract and the user-facing colour scheme.
- `%` and `$` are two representations of the same drift (one in percentage points, one in currency). Splitting the colour scheme introduces a "which one wins when they disagree?" UX question the user has to reason about.
- One-shim seam: the existing `_driftCardRows` computes `drift_class` once per row, applies it to both cells. Refactoring to a per-cell colour class would duplicate the threshold check across two render paths.

**Edge case — 0-matching rule**: when the rule matches no records, `actual%` is `—` (lib returns empty `{}` for `actual` and `drift`); `actual$` is 0 and `delta$` is `-target$`. The `$` column inherits the red class (because the rule has a target that nothing matches), but the `%` column has no class (neutral). **This is intentional.** The red `$` says "you should have $X but you have $0" — the `%` is neutral because there's no actual to compute a percentage against. ADR 0024 §5 documents this as informative signal, not a bug.

### 5. Negative `actual$` for debt records is preserved verbatim

When a rule matches a debt record (`value: -balance`, contributed as negative TWD by the shim), the `actual_amount` for that value_id is negative. The `drift_amount` is computed as `actual - target`, which can be a large negative number when the target is positive. No row filtering, no special-treatment, no "debt rows greyed out."

**Rejected**: filtering debt matches out of drift. Reasons:
- The existing v1.4 percentage drift already correctly handles negative matches (debt contributes negatively to `matching_total`; `actual%` for a debt-only bucket is `< 0`). The amount column inherits this behaviour verbatim.
- A user *wants* to see their debt's drift: "I have -$50K of credit-card debt; my rule says I should have $0; drift = -$50K" is a real signal.
- Special-casing debt records would require the lib to know about record types (holding vs cash vs debt), violating the cross-record-type decision in ADR 0013 §2. The current generic shape (`{id, currency, value}` with debt's value being negative) lets the lib stay agnostic.

### 6. Section header `Σ target` + over-100% warning

The drift section's header gains a new row showing:

- `Σ target = $X` — sum of `rule_target_amount` across all rules in the active plan, in `displayCurrency`.
- `Σ target_weight_pct = Y%` — sum of `effective_target_weight_pct` across all rules (where missing = 100 per §2).
- An over-100% warning (in `text-rose-600`, matching the existing rule-weight-sum warning at `portfolio.html:1419`) when the `Σ target_weight_pct` exceeds 100%.

The warning fires whenever the user's *intent* (the sum of their rules' target weights) is larger than the portfolio can hold. This is the loud signal that the user has multiple rules that don't fit cleanly — typically when a pre-v1.8 plan has 2+ rules and no per-rule `target_weight_pct` set (so each gets the §2 default of 100, summing past 100).

**Rejected**: silently capping `Σ target` at `netWorth`. Reasons:
- Capping hides the user's error. The point of the warning is to surface the misconfiguration.
- The user might want to "over-allocate" intentionally (e.g., they're investing beyond the current portfolio). Capping would mislead.

## Test count snapshot

At v1.17 T01 close-out (this ADR):

- `tests/plan.test.js` — 82 prior + **20 v1.17 unit tests** = **102 unit tests**
- `tests/rebalance.test.js` — unchanged
- worker contract: unchanged
- browser integration: **none in T01** (T02 owns those)

v1.17 T01 adds: **20 unit tests** in 1 file. All green via `./scripts/safety-net.sh` stage 1; stages 2–4 unaffected (T01 is lib-only).

## Consequences

### Positive

- The user can read Home drift in both units simultaneously: "I'm 5pp under-target on TW stocks" and "that's NT$X I should buy." Two representations, one truth, side by side.
- The amount math is pure, deterministic, and unit-tested at the same seam as the v1.4 percentage math (`lib/plan.js`). Adding a new amount column or tuning the threshold is `lib/plan.js` + a unit test, no DOM.
- The Home and Rebalance pages can disagree about what "missing `target_weight_pct`" means (Home = 100%, Rebalance = not eligible) without either being wrong — documented divergence, intentional per-surface design.
- The shared `drift_class` keeps the colour scheme consistent: a row that reads "drift is fine" in % also reads "drift is fine" in $, never one green and one red.
- The over-100% warning surfaces a pre-existing misconfiguration (multi-rule plans with no per-rule `target_weight_pct`) that's currently silent — users who upgraded to v1.17 with old plans will see the warning and either set explicit weights or revise the plan.

### Negative / known limitations

- **Display currency is portfolio-wide.** Users with mixed native currencies and no `displayCurrency` preference set will see one number; the per-record native target is on the Rebalance page only. ADR 0021 precedent.
- **`rule_target_amount` doesn't split when 2 rules share a value_id.** A value_id in 2 rules with `target_weight_pct: 50` each shows `$50K + $50K = $100K` total target against that value_id — but the user only needs $X of it. The over-100% warning covers the rule-sum case but not the value_id-sum case. Deferred (fog).
- **0-matching rule has neutral `%` but red `$`.** The asymmetry is informative (see §4 edge case) but visually inconsistent. Documented; not fixed.
- **No snapshot-priced `current$`.** Live `current_price` only; "what was my drift as of date X?" is out of scope (fog).
- **No multi-portfolio / multi-account.** Single-portfolio remains the unit of analysis; v1.17 inherits.

## Alternatives considered

- **Replace `%` columns with `$` columns.** Loses the percentage view many users prefer; the user explicitly chose additive (Q4 = a).
- **`lib/plan.js` computes `$` directly in `displayCurrency`.** Couples the lib to the Alpine display state; breaks the pure-function contract. Lib stays in TWD; shim converts (per ADR 0021).
- **`netWorth` becomes a required arg.** Breaks every existing caller (Alpine shim pre-v1.17, all v1.4 / v1.8 tests). The optional-arg-with-default-shape pattern (additive when present, unchanged when absent) preserves backward compat.
- **5pp threshold becomes user-configurable.** Out of scope for v1.17; deferred (OoS).
- **Per-rule display currency.** Doesn't exist in the data model; out of scope.
- **Custom `$` threshold (e.g., 5% of net worth).** Two magic numbers, broken parity with `%`. Rejected (see §4).

## References

### Internal

- [ADR 0013 — Target-allocation plans](0013-target-allocation-plans.md) — Plan rule schema, drift math (`driftForRule`), active plan pointer (basis for the amount extension; §11 cross-ref is updated by T01)
- [ADR 0017 — Region-Aware Rebalance Advisor](0017-rebalance-advisor.md) — `target_weight_pct` field; intentional divergence documented in §2
- [ADR 0021 — Act vs Measure](0021-act-vs-measure.md) — Home uses `displayCurrency`; Rebalance uses per-row native + baseline for header (basis for §3)
- [ADR 0009 §6](0009-v1.1-price-tracking.md#6-additive-fields) — additive return-shape extension (no schema bump)
- [`CONTEXT.md`](../../CONTEXT.md) — glossary entries for *Plan target amount* / *Rule target amount* / *Total plan target sum* (added in T03)
- [`lib/plan.js`](../../lib/plan.js) — `driftForRule` extended with optional 5th `netWorth` arg; `driftForPlan` mirrored
- [`lib/format.js`](../../lib/format.js) — `toTWD` for baseline conversion; shim uses `formatAmount(twd, 'TWD')` for display
- [`lib/calc.js`](../../lib/calc.js) — `Calc.netWorth(holdings, cash, debts, displayCurrency, fxRate)` — the basis for `rule_target_amount` per §1
- [`portfolio.html`](../../portfolio.html) — Alpine shim extended with `_driftCardRows` `target_str_amt` / `actual_str_amt` / `drift_str_amt` (T02); 7-column desktop table; mobile `<details>` extension; section header `Σ target` + over-100% warning (T02)
- [`tests/plan.test.js`](../../tests/plan.test.js) — +20 v1.17 unit tests for the extended `driftForRule` / `driftForPlan`
- [`tests/browser/plans.spec.js`](../../tests/browser/) — +5 v1.17 browser scenarios (T02): amount columns, missing-as-100, 0-match red $, debt negative, total warning

### Wayfinder decisions

This ADR captures grilled decisions Q1–Q7 from `.scratch/v1.17-home-plan-amounts/map.md` (Home v1.17 Round 1 Q1–Q4 + Round 2 Q5–Q7). Q1 = display currency; Q2 = net-worth basis; Q3 = treat-missing-as-100; Q4 = 7-column layout; Q5 = over-100% warning; Q6 = debt negative; Q7 = rule card header 3 lines. The colour-consistency follow-up (post-Q6) is folded into §4. Implementation tickets T01 (data + ADR + tests — this ticket), T02 (UI + i18n + browser), T03 (glossary + README + close-out) are filed at `.scratch/v1.17-home-plan-amounts/issues/`.
