# 0013 — Target-allocation plans

## Status

Accepted (v1.4)

## Context

v1 stores records (holdings, cash accounts, debts) and computes a present-tense summary on Home (totals, group-by). It does not capture the user's *intent*: there is no way to say "I want 70% of my stock holdings to be in Taiwan, 30% in the US." Without that, the only feedback loop is the raw group-by table, which describes the present but doesn't surface drift against a goal.

A personal portfolio tracker without a target allocation feature is technically complete but functionally thin: the user can see where they are but cannot see whether they're on-plan. Adding plans is a feature addition that, by nature, touches several established seams: snapshot shape (do plans live there?), sync (per-record vs scalar pointer), category lifecycle (what happens when a plan references a category that gets deleted?), and the testing safety net (where does the math live?).

The architectural questions this ADR answers are *how* the feature is wired, not *what* the feature is. The user-facing spec is the four tickets (`01–05`) under `.scratch/v1.4-target-allocation-plans/`. This ADR captures the load-bearing decisions that ticket 01–05 made and that future change should treat as locked.

## Decision

### 1. Flat rules list, not a tree

**A plan is `{id, name, rules: [PlanRule, ...]}` — a flat array.** Rules are evaluated independently against the unified record set (see §2); no rule contains another rule, and there is no grouping, no precedence, no exclusion logic.

**Rejected**: a tree structure where rules contain sub-rules and a record walks the tree to find its single bucket. Reasons:
- A tree assumes "each record belongs to exactly one rule." But the user's mental model is the opposite: a record can belong to multiple rules' `when` filters at once (e.g. "Taiwan stock" is in the "TW sleeve" rule *and* the "stock sleeve" rule). Drift against "TW sleeve" and drift against "stock sleeve" are independent measurements the user wants to see side by side.
- A tree forces the user to model allocation as a partition when their actual goals are independent targets. Flat rules compose — "all my bonds should be 50/50 TW/US" is one rule; the user does not need to encode it as "everything not in the TW stock rule must be bonds."
- Tree evaluation requires an ordered traversal with exclusive branches; flat evaluation is `records.filter(match)` per rule. The math is simpler and the model is honest.

### 2. Cross-record-type, not `applies_to`-restricted

**A rule's `when` filter is evaluated against the unified record list: holdings + cash accounts + debts.** A category's `applies_to` constrains which records *can* have the attribute, but it does not constrain which rules can reference that category. A `Category=Sector` whose `applies_to` is `['holdings']` can be used by a rule that filters across the unified set; holdings matching the category pass, cash/debts fail (they don't have the attribute).

**Rejected**: per-rule `applies_to` (the rule itself declares "I only consider holdings"). Reasons:
- The user already has a working mental model: "category X classifies these holdings; rules against X should consider holdings only" is implicit in the category's `applies_to`, not the rule's. Adding per-rule `applies_to` is duplicate state that can disagree (a category's `applies_to` says holdings only; a rule says cash too — which wins?).
- Cross-record-type is the *less* restrictive option — if a user *wants* a holdings-only rule, they can encode it by referencing only holdings-classified categories. The set of "category X only applies to holdings" rules is a strict subset of the cross-record-type space; restricting the latter forecloses nothing but the all-set.
- The unified record model (`{id, currency, value}` + parallel `recordsAttributes[recordId][catId]`) is already designed for cross-type (T01 §1); per-rule `applies_to` would be a special case the unified model has to learn about.

### 3. Single distribute per rule, not multi-target

**A rule's `distribute` is `{categoryId: {valueId: pct, ...}}` — one target category with percentages summing to 100%.** A rule does not say "distribute across both Sector and Country simultaneously."

**Rejected**: multi-target rules where `distribute` is `{Sector: {Tech: 60}, Country: {TW: 80}}` and the rule optimises across all targets jointly. Reasons:
- A multi-target distribution is a multi-dimensional allocation problem (an N-dimensional polytope of feasible allocations). For a personal portfolio this is overkill: the user thinks in terms of one axis at a time. "TW vs US in my stock sleeve" is a single dimension; "TW-vs-US AND Tech-vs-Other simultaneously" is two dimensions the user almost never wants jointly optimised.
- Drift math is per-dimension. With multi-target, drift is a vector; the user would need to choose a distance metric. With single-target, drift is a scalar per value_id, displayed in a 4-column table. The visual answer is unambiguous.
- Single-target composes into multi-dimension plans *trivially*: two rules that share the same `when` filter but different `distribute` axes give the user a joint view without the implementation having to know about it.

### 4. Active plan pointer, not per-device

**One plan is active at a time, stored as `data.active_plan_id` (a scalar string ID, or `null`).** The pointer lives on the data object, not on the device, and is synced via the coarse-grained "prefer remote, fall back to local" rule used for `meta.last_synced_at`.

**Rejected**: per-device active plans (each device remembers its own). Reasons:
- The user thinks of "the plan I'm currently working toward" as a singular intent. If Device A shows "Aggressive Growth" and Device B shows "Conservative" drift on Home, the user sees two truths and has to reconcile them. A scalar pointer means Home shows the same drift everywhere.
- Drift is a planning tool — the user wants to *act* on the gap. If the user updates a plan on Device A, they want Device B to show the new drift against that update, not drift against a stale pointer. Sync of the plan *records* (per-record LWW via `mergeById`) handles the plan data; sync of the *pointer* (scalar merge) handles the selection.
- "Prefer remote" means the device that last touched the file wins the pointer, which is the principle of least surprise for a sync-driven app.

The pointer may go orphan (the plan it references is hard-deleted on another device). The orphan is *not* silently dropped on merge — `validatePlans()` surfaces it as a warning so the UI can offer "clear" or "restore." Silent drop would lose user state without notice.

### 5. Plans are not in snapshots

**`buildSnapshot()` excludes `data.plans[]` and `data.active_plan_id` from its output.** A snapshot is `{id, date, holdings, cash_accounts, debts, fx_rate, totals, delta}` — the present-tense record set + computed aggregates, frozen at a moment in time. Plans are an intent overlay; they don't change "what the user has."

**Rejected**: snapshot includes plans + active pointer. Reasons:
- Snapshot delta is computed against the previous snapshot (per ADR 0005). If plans were inside the snapshot, snapshot delta would include "plan changed: +1 rule" noise that drowns the holdings/cash/debts delta the user actually wants to see.
- Plans don't have a "value at this moment" — they're not records. A plan can be edited without the portfolio changing; a snapshot of "the user's records at T" is meaningless without "the rules they were checking against at T" because rules evolve. Treating plans as state freezes intent that should stay fluid.
- The drift math is computed live from the current rules + current records. The user can always look at any two snapshots and ask "what was the drift against my then-current plan?" — but they cannot re-run that query unless the rules at T were preserved. So the design choice is: store the records (state) and let drift be re-computed live against the current rules (intent). Re-computation is what the user wants; preserving intent at snapshot time is not.
- Synced across devices per ADR 0011 / 0012: snapshots sync; plans sync; the two are independent.

### 6. Category deletion is blocked when a plan references it; no auto-clean

**`deleteCategory()` (and `deleteValue()`) refuse via `alert()` when any plan in `data.plans[]` references the target.** The user's plan is treated as user intent that the destructive action would silently break; the deletion is blocked, the user is told the count, and they're invited to clean up the plan first.

**Rejected**: auto-clean (cascade-delete rules that reference the deleted category/value, or strip references from rules). Reasons:
- Auto-clean is destructive *user intent*: the user wrote a rule that distributes 70/30 across Tech/Other, and a "delete Other value" action silently removes that distribution key. The plan is now in a half-state with an unrecognised distribution that may render as 70%/0% with the missing key dropped, depending on implementation. The user has no idea what just happened to their plan.
- Blocked-delete is the same pattern as the existing "category in use" block on `deleteHolding` (recordDeletion is what recordDeletion is; a category/value deletion that would break plans is the same class). The user's mental model is consistent: a deletion that would change the meaning of another item is a *modification*, not a deletion, and modifications deserve a deliberate click.
- Auto-clean can be added as a follow-up if user research shows "block" is too friction-heavy; the cheap direction is always toward more lenient (auto-clean), the expensive direction is toward stricter (block + force-confirm). Start strict.

### 7. Math in `lib/plan.js`; Alpine shims are thin

**All drift math (matching records, driftForRule, driftForPlan, validateRule, validatePlans, fxRate-aware conversion) lives in `lib/plan.js` as pure functions.** Alpine methods in `portfolio.html` are 1 call into lib + reactive bookkeeping: `activePlan()` (pointer lookup), `_buildDriftRecords()` (record-shape bridging), `driftCards()` (one call per rule + row formatting), `_driftCardRows()` (display formatting). No business logic in Alpine.

Per the AGENTS.md "Tests" rule and ADR 0010: this keeps the source of truth in testable pure functions (`tests/plan.test.js`; **66 unit tests in T01 + 5 for the T04-prep required-name retroactive**) and keeps the shim path fast to change without risking the math.

### 8. Deletion log via `Records.recordDeletion`

**Plan deletions reuse `Records.recordDeletion(records, deletions, {targetId, type: 'plans', ...})`** — the same helper used by holdings/cash/debts (per ADR 0011). The `'plans'` `type` field is added to the deletion log; sync propagates the tombstone via `mergeByIdWithDeletions`.

**Rejected**: a separate "plans deletion log" or "plans tombstones inside `data.plans[]`". Reasons: the deletion log is the established pattern; splitting would require parallel sync paths and parallel log-merge code for no benefit. Per ADR 0011 §1, the `type` field exists precisely to allow a single log to serve all record-bearing collections.

### 9. Required-name rule (T04-prep retroactive)

**A plan rule has a required `name` field** (a non-empty string, validated by `validateRule`). The plan editor enforces this pre-emptively: Save is disabled and an inline red error is shown when any rule's name is empty. No legacy migration (all existing plans were created during v1.4 development; treating the field as new-form-only is safe).

**Rejected**: optional `name` with a condition-derived fallback. Reasons:
- The drift card header shows the rule's *name* (per ticket 03 grill, variant B + rule-name-only header); an empty name would render as a blank card header. The user has no idea what the rule says.
- A condition-derived fallback ("the rule is `Sector=Tech`" → "Sector=Tech") would render the JSON-shaped condition as the visible label. That hides the user's intent behind a serialised shape and makes the card header fragile to condition changes.
- The required-name check is one line in `validateRule` and the pre-emptive editor affordance mirrors the existing "sum to 100%" pre-emption. Both are in the same UX family.

## Test count snapshot

At v1.4 close-out (commits 3cd7d35 + 298d577 + f7bee2a + 9c6347b + 0077603 + a718173 + 1fc8ff8 + T06):

- `tests/plan.test.js` — 66 T01 tests + 5 T04-prep tests = **71 unit tests**
- `tests/sync.test.js` — 17 T05 tests for plans/active_plan_id merge (74 unit tests in the file overall, the other 57 cover pre-v1.4 sync surface)
- `tests/browser/plans.spec.js` — 5 T02 tests + 1 T04-prep test = **6 browser tests**
- `tests/browser/categories-guard.spec.js` — 4 T05 tests = **4 browser tests**
- `tests/browser/drift-report.spec.js` — 7 T04 tests = **7 browser tests**
- `tests/browser/plan-flow.spec.js` — 3 T06 integration tests (create-plan → drift → roadside-guard → delete-plan → category delete succeeds; regression for no-plan baseline) = **3 browser tests**

v1.4 added: **91 unit tests + 20 browser tests** across 6 files. All green via `./scripts/safety-net.sh` (stage 1 unit, stage 4 browser smoke; stages 2–3 unaffected by v1.4).

## Consequences

### Positive

- A personal portfolio tracker now has a target allocation feature with drift against user intent. The user can answer "am I on plan?" on Home in one glance.
- The drift math is pure, deterministic, and unit-tested — adding a new rule type or changing the math is `lib/plan.js` + a unit test, no DOM.
- Cross-device sync works because plans (per-record LWW) and the active pointer (scalar merge) follow the established sync patterns from ADR 0004 and ADR 0009 §3.
- Plans don't pollute snapshot delta or backup semantics — they're intent, not state.
- Destructive operations that would silently break user intent are blocked; the user is always told what would change.

### Negative / known limitations

- **No plan history.** A plan edit doesn't keep prior versions; the user cannot answer "what was my drift against the plan I had on 2024-01-01?" without manually preserving the prior rules. Snapshot-level drift history is out of scope.
- **No multi-target rules.** The user who *does* want joint optimisation across two axes must write two rules with the same `when` filter (one per axis). This is an explicit cost of the §3 decision; the alternative (joint optimisation) is an N-dimensional problem the personal-portfolio use case doesn't justify.
- **Orphan active pointer is a warning, not auto-clear.** If a user deletes the active plan on Device A, Device B sees drift drift against a stale pointer until the user notices the warning. Auto-clearing on next sync would be safer but would silently lose state.
- **No garbage collection on plan tombstones.** Same as ADR 0011 §consequences — the deletion log grows unbounded. For plans this is even less of a concern (users rarely delete plans), but it's a known limitation.

## Alternatives considered

- **Plan as a single set of distributions, no rules.** A flat `{categoryId: {valueId: pct}}` map. Doesn't compose — the user can't say "70/30 for my stock sleeve and 50/50 for my bond sleeve" independently. Rules are necessary for the user's actual goals.
- **Weighted composite plans.** Each rule has a weight; total drift is the weighted sum. Adds an axis the user almost never wants; kept out.
- **Plan as a query against the group-by table.** Drift = "the group-by table currently shows 60% TW vs my 70% target." This is *exactly* the rule-driven approach, just without naming rules. Naming is required so the user can describe each slice independently (e.g. "the TW stock slice of my plan" maps to one rule's drift).
- **Auto-cascade on category deletion.** The destructive counterpart to §6. Rejected for the reasons above.
- **Plans in snapshots.** The state/intent conflation that §5 explicitly avoids.

## References

- `.scratch/v1.4-target-allocation-plans/` — ticket breakdown
- ADR 0004 — per-record timestamp merge (sync primitives)
- ADR 0005 — L4 snapshot shape (plans are excluded)
- ADR 0009 — v1.1 schema; load-time lazy-init migration (no version bump on adding plans)
- ADR 0010 — v1.2 testing safety net (architectural test placement)
- ADR 0011 — deletion log pattern (plan deletions reuse `Records.recordDeletion`)
- ADR 0012 — backup architecture (plans are not in snapshots, but are in `data.backups[]` automatically)
- `CONTEXT.md` — glossary entries for *Plan / Plan rule / Target distribution / Drift / Active plan*