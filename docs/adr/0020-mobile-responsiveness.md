# 0020 — Mobile Responsiveness (414 px floor)

## Status

Accepted (v1.9)

## Context

The web companion is usable on desktop browsers, but the audit (`.scratch/v1.9-mobile-responsiveness/audit-report.md`) confirmed that at 414×736 (iPhone 6 Plus / Max baseline), every page overflows horizontally (the document `scrollWidth` was 737 px vs the 414 px viewport), the second-row nav was wrapped and partially clipped, and almost every inline-table action button was sub-44-pt touch-target small. Tablets (≥768 px / `md`) already degrade gracefully via Tailwind's existing `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` patterns. Phones between 320 and 414 px were not addressed (out of scope, deferred per ticket fog).

The architectural question this ADR answers is *how* the feature is wired, not *what* the feature is. The user-facing spec is the two tickets (`01` + `02`) under `.scratch/v1.9-mobile-responsiveness/`. This ADR captures the load-bearing decisions those tickets made and that future change should treat as locked.

`portfolio.html` is a single-file Alpine.js + Tailwind app. The schema for v1.9 is unchanged (`'1.1'`) per ADR 0009 §6 — v1.9 is layout-only, no data model changes. `lib/` is also untouched; all work lives in `portfolio.html`, the regression net under `tests/browser/_mobile_smoke.spec.js`, and this ADR + glossary entry.

## Decision

### 1. Target device floor = 414 px (iPhone 6 Plus / Max)

The audit and regression net are calibrated for 414 px wide. <md (768 px) is treated as mobile. ≥md is treated as desktop. <414 px is **not** supported.

**Rejected**: 320 px floor (smallest iPhone). Reasons:
- Tailwind's `sm` breakpoint is 640 px and `md` is 768 px; the gap between 320 and 640 isn't natively covered by Tailwind's responsive utility set we'd otherwise reuse. Going to 320 px means a new `xs` breakpoint tuned to every existing component.
- The user's phone floor is 414 (iPhone Plus / Max) and common Androids cluster at 360–414. Lower than this serves no observed use case.
- 414 px is the gap between "Tailwind's `sm` (640 px)" and "phone portrait (320 px)"; treating it as the floor lets us stay inside the tailwind utility naming conventions we already use.

**Rejected**: pure-feature-detection (any viewport below some computed width). Loses the "414 px is the floor" statement that lets user-facing copy and accessibility guidance be concrete.

### 2. Tables → stacked cards via dual markup (not CSS-only `display: block`)

At < md, each record becomes a *stacked card* (`<div class="md:hidden ..." data-testid="<prefix>-card-row-<id>">`). At ≥ md, the existing `<table>` keeps its layout verbatim, wrapped with `class="hidden md:table"` so it disappears. Both templates iterate over the same data source (`getOrderedHoldings()`, `getOrderedCash()`, `getOrderedDebts()`, `card.valueRows`, `ruleCandidate.matchedRecords`) using a `:key` prefix (`'m-' + h.id`) to keep Alpine's diff from aliasing the desktop and mobile iterations.

**Rejected**: a CSS-only `display: block` rewrite of the table cells with `::before` labels. Reasons:
- Alpine 3's `x-text` binding prefers HTML elements to attribute strings; rendering `x-text="h.shares.toLocaleString()"` inside a synthetic `<td data-label="Shares">` requires the label written twice (once in `:before` for CSS, once for screen readers).
- Some Alpine state (e.g. `<template x-for>` walking children, `<details>` interactivity, `<select>` for category editor) doesn't survive `display: block` cleanly. Dual markup lets each layout use its native idioms.
- Touch-target sizing is more natural in HTML cards (`<div>` + `<button>`) than in a `display: block`-ed `<td>` with hit-area gymnastics.

**Rejected**: keeping the desktop table and adding a *separate* mobile page (e.g. `/mobile/holdings.html`). Reasons:
- Two pages means two sets of fixtures, two navigation trees, two sets of state mutations. Drift between them is inevitable.
- This codebase uses a single `portfolio.html` for every page already (ADR 0006). A new mobile sub-app would be the first such exception.

### 3. Hamburger drawer replaces the second-row 8-tab nav at < md

A hamburger button (`md:hidden min-h-[44px] min-w-[44px] p-2`) sits at the *left* of the header, before the title. Clicking it toggles `mobileNavOpen`. A right-side slide-in `<aside>` (w-72, fixed top-right, z-50) renders the 8 nav links as a vertical list; each link invokes the same `currentPage = '...'` handler as the second-row nav plus `mobileNavOpen = false`. A backdrop (`fixed inset-0 bg-black/40 z-40`) catches outside clicks and closes the drawer. Both elements use `<template x-if="mobileNavOpen">` so they're *not in the DOM* when the drawer is closed — which avoids Playwright strict-mode collisions with text-based nav locators in the desktop tests.

The second-row nav's 8 buttons each gain `hidden md:inline-block` so their computed `display` is `none` at < md (the regression net asserts this property).

**Rejected**: bottom sheet (Android pattern). Lower buttons are easier to tap but require thumb-zone accommodation that's harder to maintain across viewport sizes.

**Rejected**: top tabs visible at < md (with `overflow-x: auto`). Reasons:
- 8 tabs at 414 px is unreachable by the user; the audit confirmed the tabs wrapped and partially clipped.
- A horizontal scroll on tabs is discoverable only by accident.

**Rejected**: hiding the right action cluster on < md. The cluster (currency toggle, language toggle, refresh, sync status) is high-frequency and reaches the user regardless of view.

**Rejected**: hamburger at the right of the header. The right cluster already carries 4 buttons; squeezing the hamburger into that line crowds further. R2-Q16 settled on the left because the right is already crowded.

### 4. Holdings primary fields = ticker / shares / value / dayDelta

Each Holdings card exposes exactly 4 primary fields in the always-visible tier. Secondary fields (cost / price / 52w bar / gain-loss / Active / Edit / Delete / ↑↓ order buttons) live in the card's `<details>` block.

**Rejected**: include gain-loss in the primary tier. The day-delta color is the user's "did today matter?" signal; gain-loss is the cumulative *tax-aware* concept that's more relevant at desktop cadence.

**Rejected**: include the 52w bar in the primary tier. The bar is a dense visual element that's useful as a quick scan only; at 414 px there's no room. The `<details>` shows it on demand.

**Rejected**: include the order buttons in the primary tier. v1.6 ordering is a desktop UX; on mobile the user opens the card once, scrolls, and reorders less often. Burying ↑/↓ in `<details>` matches that pattern.

### 5. Modals stay as-is + audit verify at < md

The 5 modals (Add Holding / Add Cash / Add Debt / Intraday / Sync) keep `w-full max-w-md p-6 max-h-[90vh] overflow-y-auto` verbatim. At 414 px viewport, `max-w-md=28rem=448px` falls through to `w-full=414px` so each modal is full-width with `p-6` padding inside; vertical scrolling is handled by `max-h-[90vh] overflow-y-auto`. The audit (T01) verifies all 5 modals fit at 414 px without horizontal overflow. Cancel / Save buttons are 75×36 (mobile is generally OK with the surrounding modal padding) — accepted as low priority for spot-fix in T02 commit 6.

**Rejected**: redesign each modal into a multi-step wizard at < md. Five pages of redesigned forms is more code surface than the audit's findings justify.

**Rejected**: leave modals at full desktop dimensions (`max-w-2xl=672px`). Would overflow at 414 px.

### 6. Spot-fix touch targets; no blanket rewrite

Independent action buttons gain `min-h-[44px]` (where they're inside a card's `<details>`) or `min-h-[44px] min-w-[44px]` (where they're the hamburger trigger, single-button). Inline buttons inside table rows on desktop are NOT rewritten; cell padding provides effective hit area.

**Rejected**: blanket every `px-2 py-1` and `text-xs` button into `px-4 py-3`. Reasons:
- The audit confirmed most sub-44-pt buttons are inside table rows where surrounding cell padding handles effective hit area.
- Bulk-rewriting every small button would change the visual rhythm of the desktop UI for no measurable benefit.
- The user's tolerance for churn (per project standing preference) is "spot-fix only" — touch targets included.

### 7. HTML `<details>/<summary>` for collapsible content (mobile cards' secondary tier)

Zero JavaScript state. Native keyboard / screen-reader support. CSS gives a custom `+` / `−` marker (browser default is hidden via `summary::-webkit-details-marker { display: none }` + `summary { list-style: none }`).

**Rejected**: Alpine `x-show` collapse. Reasons:
- Each card's secondary tier doesn't need to interact with the rest of the app — pure presentation. The Alpine shim pattern (per project preference) is "thin Alpine, pure source of truth" — using Alpine for cosmetic toggles contradicts that.
- HTML `<details>` was already in use (v1.9 audit confirmed the `Internal data (debug)` block uses it); standardizing on it makes the app more consistent.
- Free accessibility: screen readers and keyboard navigation work without any extra wiring.

## Consequences

### Positive

- 414 px is now a usable viewport. v1.9 audit's "audit → fix" gate (T01 produces data, T02 acts on data) closed 11 of 18 hot-list items; the 7 deferred items (mostly touch target spot-fixes and the modal Cancel/Save buttons) are low-priority follow-ups.
- The regression net (`tests/browser/_mobile_smoke.spec.js`, 23 tests) catches future drift. Adding a new page in v1.10+ and forgetting to add mobile coverage will be flagged by stage 4.
- Glossary entries under `## Mobile` (5 entries) document the new vocabulary; "stacked card layout" and "hamburger drawer" both got entries because they're load-bearing terms future readers will encounter.
- The m- prefix convention for mobile testids (`m-holdings-move-up-<id>` etc.) avoids the Playwright strict-mode collision with the v1.6 desktop ordering tests (which query `[data-testid^="holdings-move-up-"]` and assume exactly one match — desktop `<tr>`). Future mobile ordering scenarios use the `m-` variant.

### Negative / Known limitations

- **Snapshot compare view** at 414 px: stacked card layout works, but two snapshots side-by-side are not supported (out of scope per ticket fog; same SVG-vs-stack trade-off).
- **Snapshot trend chart** SVG (`viewBox` based) renders correctly at 414 px but loses the right-side margin around the polyline. Audit noted this is acceptable; would need viewport-specific padding.
- **Tablets in portrait (768 px–1024 px)** get the desktop layout. A dedicated tablet portrait breakpoint isn't introduced; the existing `md:` Tailwind utility is sufficient.
- **Inline row buttons** in the desktop tables remain sub-44 pt by design (cell padding compensates). If a user reports a missed tap on desktop, the fix is to spot-increase the padding of the relevant `<td>`, not blanket-rewrite every small button.

### Trade-offs accepted

- **Dual markup**: every page that shows a table now carries 2 iteration templates. The trade-off is acceptable because (a) the cost is bounded (4 pages × 5-15 records each, evaluated once per render), (b) DOM duplication < 2× at small viewport (mobile cards visible, desktop table in DOM but display:none), (c) better ergonomics for mobile users.
- **Testid names diverge between mobile and desktop** (`holdings-card-row-<id>` vs `holdings-move-up-<id>` for desktop; `m-holdings-move-up-<id>` for mobile). This is a one-time cost during v1.9 that future v1.9.x mobile features will inherit.
- **Hamburger drawer lives behind an animation** (`x-transition` slide-in from translate-x-full → translate-x-0). Animation duration is 200 ms; users on slow devices may see the drawer pop in instead of sliding. Not a blocking issue but documented.

## Alternatives considered

- **CSS-only `display: block` table rewrite** — Alpine bindings awkward, label twice. Rejected (§2).
- **Separate mobile sub-app** (`/mobile/holdings.html`) — two pages, drift inevitable. Rejected (§2).
- **Bottom-sheet nav** — thumb-zone accommodation hard to maintain. Rejected (§3).
- **Top tabs visible at < md with horizontal scroll** — undiscoverable. Rejected (§3).
- **Hide the right action cluster on < md** — loses high-frequency access. Rejected (§3).
- **Hamburger at right of header** — right cluster already carries 4 buttons. Rejected (§3).
- **Include gain-loss / 52w bar / order buttons in primary tier** — visual density at 414 px is too high. Rejected (§4).
- **Redesign modals as multi-step wizards at < md** — over-scope; audit found no modal truly broken at 414 px. Rejected (§5).
- **Blanket-rewrite every small button to ≥44 pt** — visual churn for no benefit. Rejected (§6).
- **Alpine `x-show` collapse instead of `<details>`** — adds Alpine state to pure presentation. Rejected (§7).
- **Bump schema to `'1.9'`** — false signal; ADR 0009 §6 says no. Rejected (consequences).
- **320 px / 360 px floor** — serves no observed use case, breaks Tailwind's breakpoint coverage. Rejected (§1).

## References

### Internal

- [ADR 0006 — Multi-page web architecture](0006-multi-page-web-architecture.md) — single-file `portfolio.html` precedent; the second nav row is part of that multi-page-in-one-file design
- [ADR 0009 §6](0009-v1.1-price-tracking.md#6-additive-fields) — additive fields don't bump schema (basis for staying at `'1.1'`)
- [ADR 0014 — Snapshot UI](0014-snapshot-ui.md) — snapshot cards card-layout precedent (adapted for mobile via dual markup)
- [ADR 0017 — Region-Aware Rebalance Advisor](0017-rebalance-advisor.md) — `week52Style(record)` reuse between desktop and mobile; cross-reference for the v1.8 52-week marker regression test that must continue to pass on mobile
- [ADR 0015 — Record Ordering](0015-record-ordering.md) — v1.6 ordering tests query `[data-testid^="holdings-move-up-"]`; basis for the m- prefix convention
- [`CONTEXT.md`](../../CONTEXT.md) — glossary entries for *Mobile breakpoint* / *Hamburger drawer* / *Stacked card layout* / *Details expansion* / *Touch target* (T02 close-out, between `## Rebalance` and `## Snapshots`)
- [`portfolio.html`](../../portfolio.html) — single-file app; gains `mobileNavOpen` state (T02 commit 2) + per-table `hidden md:table` wrappers + per-page `md:hidden` mobile blocks (T02 commit 3-5)
- [`tests/browser/_mobile_smoke.spec.js`](../../tests/browser/_mobile_smoke.spec.js) — 23 mobile smoke tests (T01 + T02 commit 1)
- [`scripts/mobile-audit.mjs`](../../scripts/mobile-audit.mjs) — T01 audit script; re-runnable by hand to verify post-fix layout
- [`.scratch/v1.9-mobile-responsiveness/`](../../.scratch/v1.9-mobile-responsiveness/) — T01 audit report + 13 screenshots + the issue tracker (T01 + T02 tickets)
- [`.scratch/v1.10-i18n-modal-placeholders/`](../../.scratch/v1.10-i18n-modal-placeholders/) — followup discovered during T01 review (modal placeholders hardcoded in Chinese); deferred to v1.10

### External

- [Apple Human Interface Guidelines — Touch targets](https://developer.apple.com/design/human-interface-guidelines/inputs/touch-targets) — 44×44 pt minimum
- [Material Design — Touch targets](https://m3.material.io/foundations/accessible-design/accessibility-basics) — 48×48 dp minimum
- [Tailwind default breakpoints](https://tailwindcss.com/docs/responsive-design) — sm:640 / md:768 / lg:1024 / xl:1280 (the `md:` utility is the desktop cutoff for v1.9)
- [HTML `<details>` element — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details) — the v1.9 mobile secondary-tier primitive

### Wayfinder decisions

This ADR captures grilled decisions Q1–Q17 from `.scratch/v1.9-mobile-responsiveness/map.md`. Rounds 1–4 settled the viewport floor / table strategy / scope / acceptance / process / header / card / modal / touch / audit / cash-debt / split / details / version / regression / drawer placement / commit order. Implementation tickets T01 (audit script + smoke + report), T02 commits 1–6 (regression net → drawer → Holdings card → Cash/Debts card → Plans+Rebalance card → modal+touch+docs close-out) are filed at `.scratch/v1.9-mobile-responsiveness/issues/`. T02 commits 3-5 are consolidated into a single commit because the m- prefix testid rename cut across all three pages (see that commit's message for details).
