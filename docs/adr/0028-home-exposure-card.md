# 0028 — Home Exposure Card + Debts hiding at 0

## Status

Accepted (v1.21)

## Context

The Home page is a read-only summary of the user's portfolio. It
currently shows four summary cards (Net Worth, Holdings Value,
Cash, Debts) and a Group By section. v1.21 adds two changes:

1. A fifth summary card — **Exposure** — that surfaces a
   *weighted-average position multiplier* across the user's
   holdings and cash accounts. The intent: a single number that
   tells the user "how exposed is each dollar of my portfolio, on
   average, after accounting for leveraged positions and
   under-exposed cash."
2. **Hide the Debts card at 0**. The current card shows
   `0` + `"0 debt items"` whenever the user has no debts, which
   is dangling copy and grid noise.

The two changes share the same `<section class="grid …">` block
and so are shipped together. They are otherwise independent.

This ADR captures the four trade-off-bearing decisions a future
reader would want context for. The data model, the calculation,
the UI, and the test plan live in
`.scratch/v1.21-home-exposure-card/`.

## Decisions

### 1. Default categories as a first-class concept (replacing `category.role`)

**Decision.** Exposure is computed from a *Default category* — a
new system-provided kind of category that lives in a dedicated
section at the top of the Categories page. Default categories are
flagged with `isDefault: true` and seeded at load time by
`Exposure.ensureDefaultCategories(data)`. Name and `applies_to`
are read-only (system-managed); values are user-editable.

**Rejected alternative: `category.role: 'exposure'` per category.**
A `role` string on the existing user-defined category would let
the user pick any of their categories (e.g. "Sector") as the
exposure one. Simpler in the data model (one new field) but
conflates two concerns: "what does this category group?" and
"what is this category used to compute?". The user also rejected
this in a grilling round, choosing a separate system-provided
*Default category* instead, with the additional constraint that
the user cannot edit the name or applies_to of a default.

**Why this is better:**

- **Separation of concerns.** User categories group records
  (Sector, Market, Region). Default categories compute derived
  metrics (Exposure, future Risk Band). Two jobs, two flavours.
- **Constraint surface.** "Name is read-only" is a property of the
  *kind*, not a per-record flag. Modelling it as a separate kind
  makes the constraint structural; modelling it as a `role` field
  would require per-UI logic to suppress the name input.
- **Extensibility.** Adding a future default (e.g. a Risk Band
  default) is one more entry in the Default categories section +
  one more seed in `ensureDefaultCategories`. No new fields.
- **Sync safety.** Default categories persist in `data.categories[]`
  and sync via the existing `mergeByIdWithDeletions` (ADR 0016 §2).
  No new scalar pointer, no new merge clause.

**Tradeoff.** The `isDefault` flag is a one-bit indicator. If we
ever need richer metadata (e.g. "this default is read-only because
its values are computed, not user-edited"), we'd need to extend.
For v1.21 with one default, the boolean is enough.

### 2. Multiplier stored in `value.name` (parse-on-read, regex)

**Decision.** Per-record multipliers live in the Default Exposure
category's value `name` field as formatted strings like `0x`, `1x`,
`1.5x`, `2x`. The runtime extracts the number via
`parseMultiplier(name) = /^(\d+(?:\.\d+)?)x?$/i.exec(name) → 1`
on no match. The Categories page value input is a
`<input type="number" min="0" step="any">` that writes back as
`name: '{value}x'` on commit.

**Rejected alternative: a separate numeric field `value.multiplier`.**
Cleaner in the abstract, but the existing `value: {id, name}` shape
is used everywhere (Group By, Plan distribute, Rebalance). Adding
a `multiplier?: number` would either:

- (a) Be optional and silently default to 1, defeating the
  "explicit is better than implicit" principle; OR
- (b) Be required on all values across all categories, forcing
  every existing test fixture to add `multiplier: 1` even for
  non-exposure categories.

**Rejected alternative: parse from id.** The `id` is the stable
system identifier (`val-default-0x`, etc.). Overloading it with
the multiplier breaks the invariant that "ids are stable across
edits". If the user changes a value from `2x` to `3x`, the id
should stay put; the name is what changes.

**Why parse-on-read is good enough:**

- The Categories page value input is number-only, so the user
  never types a string that won't parse. The "garbage in" case
  can only happen via JSON import or a future feature; in both
  cases the default-to-1 behaviour is safe.
- The regex is permissive (allows `0.5`, `0`, `1e2` is rejected
  to keep things readable) and case-insensitive (`2X` works).
- The format `Nx` is universally readable in financial contexts
  ("2x leverage", "0.5x inverse") and locale-neutral.

**Tradeoff.** Users cannot name a value something that doesn't
parse (e.g. "Cash" for a value in the Exposure category). For
Exposure specifically, the values are always multipliers, so
non-numeric names make no sense. If a future default has free-form
values, it doesn't go through `parseMultiplier`.

### 3. Always-show Exposure card (no `—` placeholder for "no role")

**Decision.** The Exposure card is always present in the 4-card
summary grid. The card hides only when there are 0 active holdings
AND 0 active cash accounts (the genuine "no data" case). It does
**not** hide when the Default Exposure category has 0 values — in
that case the card shows `100.0%` with all records in the
Unassigned bucket (every record is multiplier 1 by default).

**Rejected alternative: card hides when the default category has
no values.** Would let us show a friendly "Add exposure values on
the Categories page" hint. But it conflates two states: "no data
to compute" and "no values to group by". A portfolio with $100k
of untagged holdings genuinely has 100% exposure (every dollar is
1×); that's a real number, not a placeholder.

**Why "always show" is right:**

- **Consistency with other cards.** Net Worth always shows (even
  if $0). Holdings Value always shows. Cash always shows. Adding
  a card that conditionally hides introduces a new visual pattern
  the user has to learn.
- **The "no values" case has a real answer.** 100% Unassigned
  *is* a valid reading. The user is not seeing a placeholder; they
  are seeing "your portfolio is 100% 1x because you haven't told
  me otherwise".
- **The grid stays balanced.** The 4-column grid stays at 4
  because the Exposure card is always the 5th slot (counted from
  1). Removing it would leave an empty slot when Debts hides too
  (which is exactly the case the Debts-hiding ticket targets).

**Tradeoff.** The "no values" case produces a non-actionable
subline (`Unassigned: $X (100.0%)`) that doesn't nudge the user
to assign exposure values. A future enhancement could add a
discreet "→ Tag your holdings on the Categories page" link, but
that's out of scope for v1.21.

### 4. Percentage display (`145.0%`, 1 decimal)

**Decision.** The headline renders as a percentage with 1 decimal
place (`145.0%`). The subline uses percent-of-total with 1 decimal
(`2x: $X (40.0%)`). No alternative format is offered.

**Rejected alternative: `1.45×` (U+00D7).** Mathematically cleaner
and matches the input vocabulary, but the user explicitly asked
for "曝險百分比" (exposure percentage) in the original spec.
`145.0%` reads as "this is 145% of the underlying value" — the
mental model the user wants.

**Rejected alternative: `1.45x` (lowercase x).** Common in
financial writing but visually too similar to `1.45` (period vs
no period). U+00D7 is unambiguous.

**Why 1 decimal:**

- 2 decimals (`145.00%`) is too noisy for a headline that
  changes with every Refresh.
- 0 decimals (`145%`) loses the precision to distinguish 1.45x
  from 1.46x — meaningful for users tracking leverage carefully.
- 1 decimal (`145.0%`) is the convention in the existing
  Holdings Value card's `holdingsGainLossPct().toFixed(2)` family
  (2 decimals for pct because it's smaller in magnitude; 1 decimal
  for the exposure pct is a deliberate choice because the exposure
  pct is typically > 100%).

**Tradeoff.** `100.0%` looks like "100.0" with an extra zero.
Some users might prefer `100%` for the round case. We could
strip trailing `.0` at format time, but that adds a special case
to the formatter and the consistency is more valuable than the
micro-saving. The user can always mentally round.

## Negative / known limitations

- **Snapshots are not affected.** Exposure is computed live from
  current state. v1.21 does not store exposure in
  `snapshot.totals`. If the user wants historical exposure, the
  cheapest extension is to compute it at snapshot view time from
  the snapshot's stored holdings + cash + the *current* category
  design. ADR 0028 does NOT ship this; it's a v1.22+ candidate.

- **No `category.role: 'exposure'` migration.** v1.21 introduces
  `isDefault: true`; there is no pre-existing `role` field in any
  shipped version, so no migration is needed. This note is for
  future readers who might wonder why the field name isn't `role`.

- **Default category deletion is impossible.** The "× Delete"
  button is omitted from the default category card. If the user
  somehow corrupts the data (e.g. via manual JSON edit), the
  `ensureDefaultCategories` lazy-add will not re-seed — they
  would need to clear `isDefault: true` on the broken entry or
  reset the portfolio.

- **Multi-currency in the subline.** Each bucket's `totalTwd` is
  the TWD sum; the displayed `formatAmount` converts back to
  `displayCurrency`. Two buckets in different display-equivalent
  amounts will show the same number after FX conversion only if
  the underlying TWDs convert to the same display amount. This is
  the existing project convention (ADR 0021); the exposure card
  does not introduce a new currency model.

- **Inactive records are excluded** from the calculation, matching
  the existing `lib/calc.js sumInTWD` filter. A user who marks a
  holding as inactive (e.g. delisted) will see that holding drop
  out of the exposure calculation immediately. This is the
  expected behaviour but is worth flagging.

## Implementation

Tracked as four tickets in `.scratch/v1.21-home-exposure-card/issues/`:

| # | File | Scope |
|---|---|---|
| 01 | `01-lib-exposure-helpers.md` | `lib/exposure.js` (parseMultiplier, ensureDefaultCategories, findDefaultExposureCategory, exposureMultiplier, exposureBreakdown) + load-flow wiring + unit tests |
| 02 | `02-categories-default-section.md` | Categories page restructured into two sections; Default Exposure card with read-only name/applies_to + number-input values |
| 03 | `03-home-exposure-card.md` | New 5th card on Home + Debts card hiding + Net Worth sub-line trimming + i18n |
| 04 | `04-tests-and-safety-net.md` | Browser smoke + i18n completeness + CONTEXT.md cross-references |

Per AGENTS.md, all four tickets must run `./scripts/safety-net.sh`
(unit tests + Worker contract + Wrangler dry-run + browser smoke)
and pass before commit.

## References

- `CONTEXT.md` — `## Exposure` section, `Default category` term
  in `## Attribute system`
- `.scratch/v1.21-home-exposure-card/spec.md` — full design
- `lib/exposure.js` — new file (T01)
- `lib/calc.js` — IIFE + module.exports pattern reference
- `lib/group.js` — `_unassigned` bucket pattern reference
- `lib/format.js` — `toTWD` / `fromTWD` FX helpers
- `lib/migration.js` — load-time normalisation hook
- `docs/adr/0016-categories-and-settings-sync.md` — category merge semantics
- `docs/adr/0021-act-vs-measure.md` — currency conversion rule
