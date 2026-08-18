# 0021 — Act vs measure: per-record native currency, aggregate displayCurrency

## Status

Accepted (v1.14)

## Context

The web companion stores every monetary value in its **native currency** (the currency the holding was bought in, or the currency the cash account is denominated in). The user's `settings.display_currency` toggle (TWD � USD) controls which currency aggregates roll up in. The split is the same "act vs measure" rule that ADR 0017 §6 established for the Rebalance page — the architectural question this ADR answers is whether that rule should also apply cross-cuttingly to the Holdings page, snapshot detail holdings, and other surfaces where the line gets crossed.

The bug surfaced in v1.14: Holdings per-share stock facts (`cost/share`, `price/share`, 52w `low`/`high`) were rendered via the Alpine shim's `formatAmount(amount, sourceCurrency)` — which calls `window.formatAmount(amount, sourceCurrency, this.displayCurrency, this.fxRate())`. The shim's contract is "format the amount", but its implementation always passes `this.displayCurrency` as the third arg, converting via FX. Result: a USD-listed holding's $50 cost/share rendered as `$1,600.00` in TWD mode and `$50.00` in USD mode — the same number visibly changed with the toggle.

The Rebalance page was unaffected because it was already wired through `formatAmountNative` (line 6174), which the v1.8 commit introduced with the comment "Per-region native currency for trade advice (per ADR 0017 §6)". The Rebalance page did the right thing; the Holdings page, snapshot detail holdings, and (still) cash/debt balance pages did not.

The architectural question is *which* rule to apply where, not *whether* to apply it.

## Decision

### 1. Per-record native currency; aggregate displayCurrency — apply cross-cuttingly

The rule from ADR 0017 §6 — per-record fields in native currency, aggregates in baseline (`displayCurrency`) — applies to **every** page, not just Rebalance. The boundary is:

- **Per-share stock facts** (`cost/share`, `price/share`, `low_52w`, `high_52w`) — native currency (listing currency). These are stock-quote facts; the user's broker app shows USD holdings in USD, and the app should too. Renaming a USD holding's cost/share from `$1,600.00` (TWD-converted) to `$50.00` (native USD) lines up with how the user thinks about per-share pricing.
- **Position-level aggregates** (`value`, `gain/loss`) — displayCurrency-converted. These are portfolio rollups; the user reads net worth in their reporting currency.
- **Cash account / debt balances** — displayCurrency-converted (unchanged from v1.14). Balances are also portfolio rollups; the user expects their cash total in reporting currency.
- **Rebalance candidates** (per ADR 0017 §6) — already native. No change.
- **Home page totals, snapshot totals, group totals** — displayCurrency-converted (unchanged from v1.14). Aggregates have no native currency; baseline is the only sensible default.

**Rejected**: always-displayCurrency (current pre-v1.14 bug). Forces every user to mentally translate USD amounts back to TWD before they can read per-share pricing. The Holdings table becomes a translation exercise rather than a portfolio view.

**Rejected**: always-native. The "net worth" total has no native currency; displayCurrency is the only sensible default for a portfolio aggregate.

**Rejected**: per-record displayCurrency with native as a tooltip / secondary line. Two layers of currency on every cell is visual noise; the dual-display pattern from Rebalance (per-record native + page-level baseline) only makes sense where there's a meaningful per-record action (trade advice), not for every Holdings cell.

### 2. Two Alpine shims — `formatAmount` and `formatAmountNative` — named for their contract

The Alpine shim layer at `portfolio.html:6163-6177` exposes two methods:

- `formatAmount(amount, sourceCurrency)` — converts to `this.displayCurrency` via `this.fxRate()` then formats. Use for **aggregates** (position totals, net worth, cash/debt balances, snapshot totals).
- `formatAmountNative(amount, sourceCurrency)` — formats in `sourceCurrency` directly (no FX conversion). Use for **per-record stock facts** (per-share pricing, 52w range, Rebalance candidate rows).

The shims map 1:1 to the two question types: "format the amount" (`formatAmount`, "I'll convert if needed") vs "format in the source" (`formatAmountNative`, "no conversion"). The names describe the contract, not the implementation. The Rebalance page's v1.8 use of `formatAmountNative` established the convention; v1.14 extends it to the 10 holdings call sites.

**Rejected**: a single shim with an explicit `native: true | false` flag. Adds a parameter to every call site; the named methods are clearer at the call site (`formatAmountNative(h.cost, h.currency)` reads as "format cost in h.currency" without reading further).

**Rejected**: making `formatAmount` always native and adding `formatAmountDisplay` for aggregates (the Q1-A option). Reasoning:
- The default flip inverts the established convention (the existing `formatAmount` is currently the "format in source" call when only 2 args are passed; post-flip, `formatAmount` is "always native" and the rare path is `formatAmountDisplay`).
- Aggregate call sites are *more* numerous than per-record ones (~24 vs ~30 across the codebase after v1.14). Making aggregates the explicit opt-in flips the convention for the majority case for no clear benefit.
- A future maintainer reading the shim should not have to remember which method is "default" — both should be self-describing.

### 3. The 10 call sites that moved from `formatAmount` to `formatAmountNative`

The Holdings table, Holdings mobile card, and snapshot detail holdings table each render `cost/share`, `price/share`, and (for the Holdings pages only) 52w `low_52w`/`high_52w`. v1.14 changes those 10 call sites from `formatAmount(h.x, h.currency)` to `formatAmountNative(h.x, h.currency)`:

| Surface | Lines | Fields |
|---|---|---|
| Holdings table (desktop, ≥md) | 650, 651, 666, 667 | cost, price, low_52w, high_52w |
| Holdings mobile card (<md) | 742, 746, 753, 754 | cost, price, low_52w, high_52w |
| Snapshot detail holdings table | 1945, 1947 | cost, price (no 52w rendered) |

The `value` cell (`shares × price`), `gainLoss` cell, and cash/debt balances stay on `formatAmount` because they remain displayCurrency-converted. No schema change; `'1.1'` is preserved per ADR 0009 §6.

**Rejected**: also moving `value` and `gainLoss` to native. The `value` cell aggregates the position total in the user's reporting currency; native value across multiple currencies makes the Holdings table a mixed-currency list rather than a portfolio view. The `gainLoss` cell is `(value - cost_basis)` in displayCurrency; both halves stay consistent.

**Rejected**: also moving cash/debt balances to native. Cash account balances and debt balances are portfolio rollups; the user expects to see "$5,000" in their reporting currency when they look at their cash total, not "$5,000 / $160,000" side-by-side.

### 4. Modal input UX stays locale-neutral (no currency suffix on label)

The Add Holding modal (`portfolio.html:2472` cost input, `:2477` price input) keeps the locale-neutral labels "每股成本" / "Cost / share" and "現價" / "Current price". The modal's currency `<select>` right above the input already implies the input's currency; adding a literal "(USD)" suffix on the label would be redundant.

**Rejected**: label suffix "(USD)" / "(TWD)". The currency `<select>` already declares the input's currency; adding a second hint is visual noise for the common case (single-currency portfolios) and still ambiguous in multi-currency portfolios (where the user reads the `<select>` value anyway).

### 5. Glossary "Display currency" entry updated to match the rule

`CONTEXT.md`'s "Display currency" entry previously claimed "Per-record fields (cost, current price) and aggregates ... both follow the toggle." — which was inaccurate even before v1.14. v1.14 rewrites the entry to explicitly distinguish per-record native vs aggregate displayCurrency, cross-references ADR 0021 (this ADR), and points back to ADR 0017 §6 for the Rebalance precedent.

## Consequences

### Positive

- A USD-listed holding's per-share pricing reads as the user expects: `$50.00` regardless of TWD/USD toggle. The Holdings table stops being a translation exercise.
- The "act vs measure" rule, previously documented only in ADR 0017 §6 (Rebalance-specific), is now a cross-cutting rule with its own ADR. Future maintainers reading `CONTEXT.md` no longer need to flip to ADR 0017 to understand why some cells call `formatAmountNative` and others call `formatAmount`.
- The 10 call sites that moved are a 10-line mechanical change with zero behavioral surprises elsewhere (every unchanged site still uses `formatAmount`, which still converts to displayCurrency).
- The v1.8 Rebalance convention is now the project-wide convention. The Rebalance page was the pilot; v1.14 retires the inconsistency.

### Negative / Known limitations

- **Same row, two currencies**: a USD holding in TWD mode now shows `$50.00 / $50.00 / $1,600.00 / ±$X` — cost/price native, value/gain in TWD. Some users will find this visually noisy. The alternative (all-native value/gain) loses the portfolio rollup; the alternative (all-displayCurrency) loses the per-share clarity. The dual display is deliberate.
- **Snapshot detail holdings** also shows the dual display: a 1.5K TWD holding in a USD-baseline portfolio shows `$1,500.00 / $1,800.00` for cost/price and `$47.00 / $9.00` for value/gain. The "same row, two currencies" concern applies here too. The ADR accepts this as the cost of preserving the act-vs-measure split.
- **Modal UX**: a user entering a USD holding's cost in the Add Holding modal has no explicit "(USD)" hint. They have to read the currency `<select>`. For users with multi-currency portfolios this is a small cognitive tax; for single-currency users it's invisible. Accepted.
- **No unit tests added in `lib/format.js`**: the existing tests already cover the `formatAmount(amount, src, src, fx)` "same currency both sides" path under "TWD display", "USD display", "Thresholds", and "FX rate effect" headings. Adding duplicate tests for the same code path is noise; the browser test (`tests/browser/holdings-currency.spec.js`) is the new behavioral seam.

## Alternatives considered

- **Always-displayCurrency** (the pre-v1.14 behavior) — UX regression; user has to mentally translate per-share USD to TWD. Rejected (§1).
- **Always-native** — aggregates (net worth, group totals, snapshot totals) have no native currency; baseline is the only sensible default. Rejected (§1).
- **Per-record displayCurrency with native as secondary tooltip** — visual noise; only useful where there's a meaningful per-record action. Rejected (§1).
- **Single shim with `native: true | false` flag** — named methods are clearer at the call site. Rejected (§2).
- **Q1-A: make `formatAmount` shim always native, add `formatAmountAsDisplay` for aggregates** — flips the established default; aggregate call sites are the majority. Rejected (§2).
- **Move `value` and `gainLoss` to native too** — breaks the portfolio rollup; mixed-currency Holdings table. Rejected (§3).
- **Move cash/debt balances to native too** — same problem at the Cash/Debts page. Rejected (§3).
- **Add "(USD)" / "(TWD)" suffix to Add Holding modal labels** — redundant with the currency `<select>` immediately above. Rejected (§4).
- **Add unit tests in `lib/format.js` for the native path** — duplicate coverage of code already tested via `(src, src, fx)` paths. Rejected (consequences).

## References

### Internal

- [ADR 0017 §6 — Per-region native currency for trade advice; baseline currency for total drift %](0017-rebalance-advisor.md) — the v1.8 Rebalance precedent; v1.14 retires the inconsistency that v1.8 left behind
- [`CONTEXT.md`](../../CONTEXT.md) — "Display currency" entry rewritten to reflect the act-vs-measure split
- [`portfolio.html`](../../portfolio.html) — 10-line change in the Holdings table (650/651/666/667), Holdings mobile card (742/746/753/754), and snapshot detail holdings table (1945/1947); all call sites switch from `formatAmount` to `formatAmountNative`
- [`tests/browser/holdings-currency.spec.js`](../../tests/browser/holdings-currency.spec.js) — 4 new Playwright tests (RED → GREEN on the act-vs-measure seam; regression on value/gain)
- [`.scratch/v1.14-act-vs-measure/`](../../.scratch/v1.14-act-vs-measure/) — issue tracker (one ticket)

### External

- None (no third-party API changes).

### Wayfinder decisions

This ADR captures grilled decisions Q1–Q5 from the v1.14 interview (recorded in the ticket's `## Comments` section if added; this v1.14 was a small enough scope to skip the formal map.md). Q1 settled on the per-call-site rename (B) over the shim-layer default flip (A); Q2 narrowed scope to cost/share + price/share + 52w range (10 sites) rather than all per-record fields; Q3 declined modal UX hint; Q4 confirmed the named-shim convention; Q5 confirmed this ADR.
