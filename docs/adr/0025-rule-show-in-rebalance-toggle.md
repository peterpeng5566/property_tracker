# 0025 — Per-rule "Show in rebalance page" toggle

## Status

Accepted (v1.19)

## Context

[ADR 0017 §1](0017-rebalance-advisor.md#1-extend-planrule-with-optional-target_weight_pct)
makes a rule *rebalance-eligible* iff `rule.target_weight_pct` is a finite
number in `[0, 100]`. [Home (ADR 0024 §2)](0024-home-plan-amounts.md#2-treat-missing-target_weight_pct-as-100-on-home)
treats a missing `target_weight_pct` as `100%` for amount-column display.
The two surfaces have always had different semantics for the same field;
they agree on what *data* the rule carries but disagree on what it means
that the data is missing.

This ADR addresses a third "meaning" the user has asked for: the ability to
keep a rule on the user's Home drift report while hiding it from the
Rebalance page. Today the only way to do that is to clear
`target_weight_pct` — but doing so also changes Home's `rule_target_amount`
(treating the rule as 100% of net worth), which is a different signal
than "the user just doesn't want rebalance advice for this sleeve."

The user has asked for a per-rule UI to control Rebalance-page visibility
independently of `target_weight_pct`. Default: **not shown** — opting in
is the explicit action.

The architectural questions this ADR answers are about *how* the new
toggle composes with existing surfaces — not *what* the feature is. The
user-facing spec is the one ticket
(`.scratch/v1.19-rule-show-in-rebalance/issues/01-add-toggle.md`).

The plan data model (ADR 0013) and rebalance eligibility predicate
(ADR 0017 §1) already exist; v1.19 extends the rule shape with one
additive boolean field, gated through `lib/rebalance.js` `_isEligible`.

## Decision

### 1. New optional field: `rule.show_in_rebalance`

A rule gains one new optional boolean field:

```ts
type Rule = {
  ...existing fields,
  target_weight_pct?: number,           // existing (ADR 0017 §1)
  show_in_rebalance?: boolean,          // NEW — v1.19
};
```

`Plan.validateRule` accepts boolean or absent; rejects any other value
(string, number, object) so the storage shape is unambiguous. New rules
created via `Plan.newRule()` default `show_in_rebalance: false`. Pre-v1.19
rules (no field) are treated as `false` by the eligibility predicate (strict
`=== true` check below).

### 2. Eligibility predicate gains a `show_in_rebalance === true` check

`lib/rebalance.js` `_isEligible(rule)` becomes:

```js
function _isEligible(rule) {
  if (!rule || typeof rule !== 'object') return false;
  const tw = rule.target_weight_pct;
  if (tw === undefined || tw === null) return false;
  if (typeof tw !== 'number' || !Number.isFinite(tw)) return false;
  if (tw < 0 || tw > 100) return false;
  if (rule.show_in_rebalance !== true) return false;   // v1.19 addition
  return true;
}
```

The strict `=== true` check (rather than truthy) defends against future
serialisers that might write `"true"` or `1` instead of a real boolean —
the UI only writes booleans, so the strict check matches the storage
shape exactly.

The Alpine shim's `hasRebalanceEligibleRules()` mirrors the same predicate
inline (so the Alpine reactivity tick stays O(rules) — we don't call into
`computeCandidates` on every reactive change). The shim's predicate
**must** stay in sync with `_isEligible`; an inline comment + a code-review
checklist item make this explicit.

**Rejected**: filtering eligibility at the Alpine shim only (keep
`_isEligible` unchanged). Reasons:

- The lib is the source of truth for "what does rebalance advise?"
  (ADR 0017 §1 establishes the pattern: eligibility is a property of the
  rule, not the UI). Putting the check in the shim would mean two
  callers — `computeCandidates` and `computeTotalDrift` — need to
  duplicate it.
- Future tests of `computeCandidates` / `computeTotalDrift` would need
  to set the toggle on every rule fixture or the test would silently
  produce no output (a worse failure mode than the current explicit
  "rule has no target_weight_pct" case).

**Rejected**: deriving `show_in_rebalance` from `target_weight_pct` (e.g.
"present means shown"). Reasons:

- The user's stated requirement is "default is not showing". A rule
  with `target_weight_pct` set but the toggle off is a legitimate
  drift-tracking-only configuration — folding them into one field
  would force the user to abandon drift visibility to disable
  rebalance advice, which is the opposite of the user's mental
  model.

### 3. `Plan.newRule()` default: `show_in_rebalance: false`

New rules arrive with the toggle off. Pre-v1.19 rules without the field
are *also* treated as off by the strict `=== true` check (default-off,
not default-on migration). The user explicitly asked for this ("default
is not showing"); this is a one-time re-opt-in for upgrade users who
previously relied on `target_weight_pct` alone.

**Rejected**: migrate pre-v1.19 plans to set `show_in_rebalance: true` on
every rule that has `target_weight_pct`. Reasons:

- ADR 0009 §6 says additive fields don't auto-migrate. The user
  chose "default is not showing" knowing it would affect upgrade
  behaviour; auto-migrating to `true` would defeat the purpose.
- Surfacing the toggle in the plan editor (a one-click re-opt-in)
  is the explicit way to make the change visible to the user.

### 4. Home is unaffected by `show_in_rebalance`

The Home "Plan vs Actual" drift section (ADR 0024) does not read
`show_in_rebalance`. A rule with `show_in_rebalance: false` still shows
up on Home's drift report exactly as it did before v1.19. The toggle
is *only* a Rebalance-page filter.

This means a rule can be:

- **drift-only**: `target_weight_pct` unset / null + any
  `show_in_rebalance` → visible on Home, not on Rebalance.
- **drift + rebalance**: `target_weight_pct` finite in [0, 100] +
  `show_in_rebalance: true` → visible on both.
- **drift-tracker, no Rebalance advice**: `target_weight_pct` set
  + `show_in_rebalance` false/absent → visible on Home (with its
  amount column) but NOT on Rebalance.

The three configurations are independent on Home (which always shows
drift) and only the last two differ on Rebalance (the third is new
behaviour).

### 5. UI: checkbox sits next to `target_weight_pct` in the plan editor

A single checkbox per rule, with label "Show in rebalance page"
(i18n: `plan.editor.showInRebalance`) and a help-line ("Tick to include
this rule on the Rebalance page. Leave unticked to keep it as a
drift-only rule on Home."). The default checked state is OFF.

`data-testid="plan-rule-show-in-rebalance"` drives browser tests. The
existing v1.8 `plan-rule-target-weight` input is unchanged.

A new Alpine shim method `setRuleShowInRebalance(rIdx, value)`
normalises the input to a real boolean and writes it through
`rule.show_in_rebalance = value === true`.

The empty-state subtitle on the Rebalance page is updated from
"Add a target_weight_pct to one or more rules" to "Set a
target_weight_pct and tick 'Show in rebalance page' on one or more
rules" so users hitting the empty state see both requirements.

### 6. Schema stays at `'1.1'`; rule-field merge path unchanged

The change is additive at the field level. The merge behaviour change
(`show_in_rebalance` is now part of the rule's merge unit) lives in the
existing `mergeByIdWithDeletions` on `data.plans[]` (per ADR 0004 +
0016) — but no new merge code is needed, because the rule is the merge
unit. When a plan's `updated_at` is newer, the entire plan object
(including `rules[].show_in_rebalance`) replaces the older plan.

Pre-v1.19 plans (no `show_in_rebalance`) load into v1.19 cleanly:

- The validator accepts the absence (defaults to false at the
  eligibility check).
- `Rebalance.computeCandidates` skips rules where the field is
  absent / false.
- The Alpine shim treats the absence as false (matching `_isEligible`).
- No schema version bump.

**Rejected**: bump to `'1.19'` for migration purposes. Same reasoning
as ADR 0017 §9 — additive fields don't bump.

## Consequences

### Positive

- The user can keep a rule on the drift report without it generating
  rebalance advice — the three configurations from §4 are now
  possible.
- The lib remains the single source of truth for eligibility
  (`hasRebalanceEligibleRules` is a thin mirror, not a separate
  decision).
- Pre-v1.19 rules degrade gracefully (default-off, then opt-in via
  the new checkbox).
- Storage shape is unambiguous: validators reject non-boolean
  `show_in_rebalance`; strict `=== true` mirrors the validator's
  acceptance contract.
- Schema stays at `'1.1'`; merges cover the new field without code
  change.

### Negative / known limitations

- **Re-opt-in cost for upgrade users**: any user with rules that had
  `target_weight_pct` set in v1.8 will see those rules disappear from
  the Rebalance page on upgrade; they must open each plan rule and
  tick the new checkbox. The Rebalance page empty-state subtitle
  explains both requirements; the Close-out ticket should mention
  this in the changelog.
- **Two predicates to keep in sync**: `lib/rebalance.js _isEligible`
  and `portfolio.html hasRebalanceEligibleRules` are duplicated
  (Alpine reactivity demands an inline O(rules) check). A code-review
  checklist item + a comment at both sites nudge future contributors.
- **Defaulting off means rebalance can feel "lost"** the first time
  the user visits v1.19. The empty-state CTA points at the plan editor;
  the plan editor checkbox is the onramp. No in-product tour yet.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| New `show_in_rebalance` boolean (not derived from `target_weight_pct`) | One new field per rule; independent drift / rebalance visibility |
| Strict `=== true` eligibility check | Defends against future stringly-typed serialisation; rejects truthy non-booleans |
| Default new-rule `show_in_rebalance: false` | Matches user's "default is not showing"; upgrade users re-opt-in |
| No auto-migration on upgrade | One-time re-opt-in cost for previously-eligible rules; matches ADR 0009 §6 |
| Eligibility check inside `lib/rebalance.js _isEligible` (not just shim) | Single source of truth; shim mirrors inline for reactivity |
| Checkbox UI next to `target_weight_pct` | Co-located with the field it complements; one save |
| Schema stays at `'1.1'` | No version bump; merge path unchanged |
| Home ignores `show_in_rebalance` | Independence preserved; ADR 0024 §2 still applies |

## Alternatives considered

- **Filter eligibility only at the Alpine shim layer** — duplicate
  predicate in every caller; tests pass strings/falsy values
  silently. Rejected (§2).
- **Derive `show_in_rebalance` from `target_weight_pct` presence**
  — collapses two distinct user intents ("I want drift only" vs "I want
  rebalance"). Rejected (§2).
- **Migrate pre-v1.19 plans to `show_in_rebalance: true`** —
  contradicts the user's "default is not showing"; ADR 0009 §6 forbids
  auto-migration for additive fields. Rejected (§3).
- **Per-rule `target_weight_pct` "off" sentinel**: keep the current
  "absent = not eligible" semantic — adds a new "100% = not eligible"
  mode. Rejected: too implicit; the user's mental model is a
  two-dimensional "drift? / rebalance?" matrix, not a magic-number
  code.
- **Page-level toggle** (one switch for all rules) — over-broad; the
  user asked for per-rule. Rejected.

## References

### Internal

- [ADR 0017 §1](0017-rebalance-advisor.md#1-extend-planrule-with-optional-target_weight_pct)
  — original eligibility predicate; this ADR extends §1 by adding a
  second required condition.
- [ADR 0004 — Per-record timestamp merge](0004-per-record-timestamp-merge.md)
  — per-record newer-wins is the merge primitive for plans and their
  sub-fields; the new boolean rides the rule's existing `updated_at`.
- [ADR 0009 §6](0009-v1.1-price-tracking.md#6-additive-fields)
  — additive fields don't bump schema; pre-v1.19 plans load into
  v1.19 cleanly without migration.
- [ADR 0024 §2](0024-home-plan-amounts.md#2-treat-missing-target_weight_pct-as-100-on-home)
  — Home's distinct semantic for missing `target_weight_pct`. v1.19
  extends the rule shape, not Home's display.
- [`CONTEXT.md`](../../CONTEXT.md) — glossary entries for
  *Rebalance-eligible rule* (updated to mention both conditions) and
  *Show in rebalance* (new).
- [`lib/plan.js`](../../lib/plan.js) — `newRule()` defaults
  `show_in_rebalance: false`; `validateRule()` accepts boolean or
  absent; both are tested in `tests/plan.test.js`.
- [`lib/rebalance.js`](../../lib/rebalance.js) — `_isEligible()` adds
  the `=== true` check; tested in `tests/rebalance.test.js`.
- [`portfolio.html`](../../portfolio.html) — checkbox markup with
  `data-testid="plan-rule-show-in-rebalance"`; Alpine shim
  `setRuleShowInRebalance(rIdx, value)`; inline mirror predicate at
  `hasRebalanceEligibleRules()`. i18n keys in EN + ZH.
- [`tests/rebalance.test.js`](../../tests/rebalance.test.js) — toggle
  default-off tests, `ruleEligible()` factory updated, toggle-specific
  unit tests.
- [`tests/plan.test.js`](../../tests/plan.test.js) — `newRule()` test
  + `validateRule()` acceptance / rejection tests.
- [`tests/browser/rebalance.spec.js`](../../tests/browser/rebalance.spec.js)
  — fixtures updated to set `show_in_rebalance: true` on
  rebalance-eligible rules; new "toggle off → empty CTA" and
  "unticking via plan editor hides rule" tests.

### Wayfinder decisions

User-provided; no grilling rounds. The decision tree was:

1. *How does the new field compose with `target_weight_pct`?*
   → strictly **AND** inside `_isEligible` (lib is source of truth).
2. *What does "default is not showing" mean for upgrade?* → no
   auto-migration; pre-v1.19 rules default to *off*; user re-opts
   in via the plan editor checkbox.
3. *Does Home see this?* → no; Home keeps its own
   `effective_target_weight_pct = 100` semantic from ADR 0024 §2.
4. *Which UI affordance?* → checkbox next to the `target_weight_pct`
   input; default OFF; help text explains the dual-purpose rule.
