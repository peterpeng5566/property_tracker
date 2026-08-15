# 0014 — Snapshot UI (v1.5)

## Status

Accepted (v1.5)

## Context

v1.0 reserved `data.snapshots[]` in the schema but did not use it; v1.1 added the `Snapshot.buildSnapshot()` engine, total/delta computation, and a minimal "Take this portfolio as a snapshot" back-room button — but no UI surface for browsing, viewing, comparing, or charting them. After v1.4 (Plans), drift is per-day only; snapshots are the only place a historical record of the portfolio lives. After v1.3 (Backups), two layers of automatic backup exist for rollback; the snapshot store is the user's *manual* historical record, distinct from rollback.

The architectural questions this ADR answers are *how* the UI is wired, not *what* a snapshot is. The snapshot engine itself was settled by ADR 0005; this ADR covers the UI layer that consumes it. The user-facing spec is the six tickets (`01–06`) under `.scratch/v1.5-snapshot-ui/`. This ADR captures the load-bearing decisions those tickets made and that future change should treat as locked.

## Decision

### 1. Manual-only CRUD; no auto-capture, no restore-from-snapshot

**Snapshots are user-initiated, via a "Take snapshot" button on the Snapshots page.** No background scheduler, no "auto-take on first save of the day," no diff-on-the-side. Delete is user-initiated from the list row. There is no "restore portfolio from snapshot" operation; the Backups layer (ADR 0012) is the rollback story; the snapshot store is read-only history.

**Rejected**: auto-take on a schedule, restore-from-snapshot, or treat snapshots as "the second backup layer." Reasons:
- Rollback (Backups per ADR 0012) is automatic, full-state, two-layer, and self-protected; manually curated history (Snapshots) is selective, manual, and read-only. Conflating them doubles the documentation burden for no user benefit — Backups already covers the catastrophic-recovery case Snapshots would otherwise need to.
- Auto-capture hurts the take-overwrite UX: if the engine silently captures one per day, the "I'm going to overwrite today's snapshot" confirm dialog starts appearing without user intent, training the user to click through.
- Restore-from-snapshot wants the snapshot engine to be a *reversible mutator* on the live portfolio, which forces snapshot deltas to be replayable (subsumption rules, deletes, attribute moves). That's a different storage shape; the existing L4 snapshot (ADR 0005) intentionally freezes totals and reject-attempting-restore semantics.

### 2. Snapshot cap: 365 FIFO; user-configurable; `0 = unlimited`

**Each portfolio stores `settings.snapshot_cap` (default `365`, FIFO, user-configurable via the Snapshots page).** When a take-snapshot operation would exceed the cap, oldest snapshots are dropped from the front. The `0` value is the explicit "unlimited" sentinel. The cap is enforced by a pure helper (`Snapshot.pushSnapshotWithCap`) so the GC logic is testable without Alpine.

`Snapshot.normalizeSnapshotCap(rawValue)` is the load-time lazy-init sanitizer: missing, negative, non-number, or non-finite → `365` (default); `0` → `0` (unlimited preserved); positive integers preserved as-is. The same sanitizer is invoked by the import path (`handleImportFile`) so a v1.0/v1.4 backup file that has no `snapshot_cap` key is silently upgraded to the default without a schema-version bump.

**Rejected**: fixed-no-cap (storage grows unbounded — risks hitting Chrome's 5–10 MB localStorage quota within a few years of daily use), tiered caps (daily/weekly/monthly buckets — extra complexity, opaque to the user), or time-window-based GC (requires per-snapshot TTL tracking). Reasons:
- Pure count + FIFO is the simplest correct answer to "keep my portfolio history bounded." Bounded count → predictable storage footprint → no quota errors.
- The cap is *user-configurable* on the Snapshots page so the user can dial it up (a power user who wants 10 years of history can set 3650) or down (a casual user can set 30). The 365 default is "about a year of daily snapshots" — long enough to chart, short enough to fit comfortably in quota.

### 3. Engine stays as source of truth; Alpine methods are thin shims

**All snapshot business logic lives in `lib/snapshot.js` (already pure).** Alpine methods in `portfolio.html` are one call into lib + reactive bookkeeping:
- T02 — `snapshotListRows` getter calls `Array.reverse()`. Cap-usage formatting is a thin wrapper over `snapshot_cap`.
- T03 — `currentSnapshotDetail` / `getAttrBadgeKind/Label/Hint` thin shims over `Snapshot.resolveAttributeRef`. The 4 mini-totals call `formatAmount(d.value, this.displayCurrency)`.
- T04 — `compareDelta` wraps `Snapshot.computeDelta(...)`; UI sort + classification logic (`compareRows()`) lives in Alpine because it's a UI-shape concern.
- T05 — `chartSeries()` calls `Snapshot.toDisplaySeries(arr, this.displayCurrency)`; geometry math (`_chartX`, `_chartY`, `chartDomain`) lives in Alpine because that's pure UI-side coordinate mapping.

Per the AGENTS.md "Tests" rule and ADR 0010: source of truth in `lib/` (`tests/snapshot.test.js` carries the heavy coverage — T01 added 18 tests, T03 added 8, T04 added 2, T05 added 9); shim path is fast to change without risking the math.

### 4. Nav page (Snapshots), not Home-embedded

**Snapshots live behind a 5th top-level nav destination (Home / Holdings / Cash & Debts / Categories / **Snapshots**), reached via header nav.** The Snapshots page is its own full screen with the same chrome (Take button + cap usage) as the rest of the app.

**Rejected**: Home-embedded card (a "snapshots" section under the totals), Home-totals link-out, or modal-only. Reasons:
- Snapshot UI is multi-mode (list / detail / compare) and needs room for a chart at the top. Home is totals + drift — already full; bolting snapshots on top clutters a page that's supposed to answer "where am I now?" in one glance.
- The chart + list + compare is a *sub-app* of equal depth to Holdings. Equal-depth surfaces deserve equal-depth nav.

### 5. List / Detail / Compare are mutually exclusive; one screen, mode-switched

**On the Snapshots page, exactly one of list mode / detail mode / compare mode is visible at a time, driven by `x-show` on Alpine state (`currentSnapshotDetail`, `compareIds`, plus their negations as implicit list mode).** The Take button + cap-usage are page chrome and stay rendered across all three modes; the chart stays rendered (mode-switching is layout-only).

**Rejected**: three separate pages (one URL per mode), modal stacks, or sidebar detail. Reasons:
- The Snapshots page already has full nav-page context; switching to a new route (URL or pseudo-page) doesn't add value — mode is in-memory only per ADR 0006.
- Stacked modals lose the page context (cap, list, chart) the user may want while looking at a detail.
- The chart stays rendered across all three because hiding it would force an Alpine re-init on every mode switch and the user wants to keep seeing trend context while inspecting a detail.

### 6. Snapshot detail freezes currency; orphan attribute refs render with a hint

**Detail view always reads totals and per-record prices from `snap.totals.displayCurrency` (frozen at capture time per ADR 0005).** The detail page does NOT re-pivot to the current `display_currency` setting — that would silently misrepresent historical state. Multi-currency is resolved at capture time, not display time.

When a snapshot references a (category, value) pair that has been renamed or deleted since, the cell shows the orphan glyph (`?` for an orphan value, `—` for an orphan category) with an i18n key as a `<title>` hint, per ADR 0003. Pure helper `Snapshot.resolveAttributeRef(categories, catId, valId)` returns `{kind, label, hintKey}` — the UI is one shim that maps `kind` to a CSS class and `hintKey` to a tooltip.

**Rejected**: silently drop the orphan (no UX signal — the user can't tell "missing" from "actual blank value"), inline the orphan value text + an unhelpful error (worse than `?` — clutters the table), or block taking snapshots when categories are about to be deleted (assumes the user knows the future, which they don't).

### 7. Compare is exactly-two; FIFO trim on over-selection; same-snapshot is allowed

**Compare view requires exactly two `selectedSnapshotIds[]`.** Selecting a 3rd trims the oldest (FIFO) so the user always sees the most recent two. Same-snapshot compare (both ids equal) is allowed and surfaces a "comparing a snapshot to itself" notice with all-zero deltas; blocking it would prevent the user from reaching `Δ 0` for a sanity check.

The comparison grid renders a delta band (5 totals + net-worth Δ% via the new pure helper `Format.deltaPercent(num, denom)`); a per-holding table sorted by `Math.abs(totalDelta)` desc, ties by ticker asc; and Added/Removed sections for holdings that exist in only one side. `denom === 0` or non-finite → `—` (honest signal, mirrors the null-price handling).

**Rejected**: 3-way compare (multi-pair chart UX complexity for marginal use), ternary compare picker (over-selection handling unclear), or block same-snapshot (prevents the user from seeing "Δ 0 is correct, this snapshot genuinely didn't change between the two timestamps I selected").

### 8. Trend chart: inline SVG sparkline, zero JS resize, two polylines, frozen-fx reconvert

**The trend chart is an inline SVG element at the top of the Snapshots page (above the T04 compare bar).** Two `<polyline>` elements — `totals.netWorth` (slate-900, 2px primary) and `totals.holdingsValue` (emerald-500, 1px semi-transparent secondary). Single shared y-axis with 3 raw min/mid/max ticks via `formatAmount`. Equal-spacing x (index 0..n-1) — the chart is a "snapshot history," not a calendar trend; the x-axis is "step index" not "days since first snapshot." The SVG uses `viewBox + preserveAspectRatio="xMidYMid meet"` so it scales on resize with zero JS.

The chart is intentionally split direction from the list: **chart oldest→newest** (time-series mental model, left-to-right reads as time progression) while **the list stays newest-first** (activity-feed mental model, most-recent-at-top matches user expectation per T02). The two directions don't compose into one component because the semantic axes are different.

For multi-currency portfolios, each point is reconverted to the *current* `display_currency` using *that snapshot's own frozen* `fx_rate` (per T05's locked decision that "you cannot retroactively revalue history, but you can show history in today's currency"). TDD seams: `Format.convertCurrency(amount, source, target, fxRate)` in `lib/format.js` (raw number helper composing `fromTWD(toTWD(...))`); `Snapshot.toDisplaySeries(snapshots, currentDisplayCurrency)` in `lib/snapshot.js` (sorts ascending by date, applies `convertCurrency` per-snap).

Hover: SVG `<title>` browser-native tooltip — zero JS, typography auto, no positioning hell. Bidirectional chart-row hover sync via a new Alpine state `hoveredSnapshotId`; the corresponding list row gets `ring-2 ring-slate-300`, set by `@mouseenter` on the chart dot and consumed via `:class` on the list row.

1-snapshot state shows only the netWorth single dot + caption; the holdingsValue line needs ≥2 points to have trend semantics.

**Rejected**:
- Calendar-spaced x (`x = ms(date)`) — would compress early daily snapshots to a single pixel when a user takes 30 days of snapshots then a 6-month gap; equal spacing reads cleaner for the use case.
- 1 polyline (net-worth only) — loses the "stock vs total" comparison the user wants to see (per R1-Q4 grilling).
- JS-resize listener — adds a listener, debounce, and re-layout; `viewBox + preserveAspectRatio` is sufficient.
- Custom tooltip (HTML overlay) — SVG `<title>` is built-in, accessible, and zero JS.
- HTML-positioned dots (percent-based absolute positioning) — would drift from the polylines on container resize unless aspect ratio is also locked; rejected for the complexity.

### 9. Snapshot UI does not introduce a new schema version

**The schema `version` field stays at `'1.1'`** through v1.5 (defined by ADR 0009 §7 as the "additive fields only" migration strategy). Adding `settings.snapshot_cap` is additive: missing keys are lazy-initialised to the default by `normalizeSnapshotCap`. No migration code, no version bump, no "I'm from v1.4 / I'm from v1.5" branching.

**Rejected**: bump to `'1.5'` for the snapshot cap. Reasons:
- ADR 0009 established the additive principle specifically for fields like this. Bumping would impose `if (version === '1.0') migrate(); if (version === '1.4') migrate(); ...` for every consumer and create a long tail of versioned code paths.
- The lazy-init helper is one of the recommended canonical load-time upgrade patterns from ADR 0009; using it keeps the schema a single source of truth.

## Test count snapshot

At v1.5 close-out (commits f0e6903 + 53b61e9 + 2f278fc + 00b1093 + bef080e + T06):

- `tests/snapshot.test.js` — 18 T01 (cap) + 8 T03 (resolveAttributeRef) + 2 T04 (computeDelta totals deltas) + 9 T05 (toDisplaySeries) = **37 new tests** (in addition to pre-existing engine tests)
- `tests/format.test.js` — 7 T04 (`deltaPercent`) + 7 T05 (`convertCurrency`) = **14 new tests**
- `tests/browser/snapshots.spec.js` — 5 T02 + 4 T03 + 4 T04 + 6 T05 = **19 browser tests** (5 T01 cap scenarios covered by existing unit tests; no browser smoke needed for pure-helper GC)

v1.5 added: **51 unit tests + 19 browser tests** across 3 files. All green via `./scripts/safety-net.sh` (4 stages: unit, Worker contract, Wrangler dry-run, browser smoke).

## Consequences

### Positive

- The user can now take, list, view, compare, and chart portfolio history on-device with no backend dependency.
- Snapshot storage is bounded (FIFO cap, user-configurable); the localStorage quota risk is bounded, not eliminated.
- Snapshot business logic remains pure & unit-tested in `lib/snapshot.js`; the UI stays a thin shim over a tested source of truth.
- Read-only history is the right scope: no accidental "restore from snapshot" foot-gun competing with Backups.
- Cross-device snapshot sync continues to work (per ADR 0004 — `mergeById`); deletions propagate via `Records.recordDeletion(arr, deletions, {type: 'snapshots'})`.

### Negative / known limitations

- **No auto-take.** A user who forgets to click Take loses that day's history. Acceptable: the user wouldn't benefit from auto-takes they didn't ask for (per §1).
- **Trend chart shows only 2 series** (netWorth + holdingsValue). Cash, debts, and per-holding totals are not plottable. Acceptable: extending the chart to N series would force a legend redesign and per-series toggles; the two-series answer covers the dominant user question ("how is my net worth trending, and is it the stocks moving it or the cash?").
- **Chart `x` is step-index, not calendar.** Two snapshots taken 1 day apart look the same distance apart as two snapshots 6 months apart. Acceptable: the chart is "snapshot history," not "calendar trend"; the dates are surfaced in the tooltips and on each list row, so the user can correlate.
- **Compare is exactly-2, no N-way.** A user wanting to see "snap-A vs snap-B vs snap-C" must do AB then BC. Acceptable: N-way comparison is an order of magnitude more UI complexity (3 columns, 3-way delta math, 3-way grouping); 2-way covers the use case.
- **Snapshot deltas use the SAME `delta` field that ADR 0005 defines.** `delta` was originally a payload field computed at capture time and stored in the snapshot. T04's `computeDelta(prev, current)` is the lazy / re-computable counterpart used by compare — a slight terminology overlap. Future readers should note `snap.delta` is capture-time-computed-and-stored; `Snapshot.computeDelta` is runtime-computed-by-the-UI.

## Alternatives considered

- **Restore-from-snapshot as the third backup layer.** Rejected per §1: duplicates Backups' job.
- **Auto-capture on first save of the day.** Rejected per §1.
- **Calendar-shaped x-axis.** Rejected per §8 — equal spacing reads cleaner.
- **Calendar-true-time gaps shown via dashed segments.** Considered and rejected: doubles the renderer complexity for a small win on an edge case (user takes one snapshot, then nothing for months, then resumes). The cap (default 365) already bounds the worst-case gap.
- **Plans in the snapshot chart drift band.** Rejected per ADR 0013 §5 — snapshot is present-tense state, not intent; mixing creates the "what was I planning on this date?" ambiguity.
- **History chart of all snapshots with per-axis scale, like Google Finance.** Considered; a full chart UI is out of scope for v1.5 (would need Y-zoom, X-zoom, brush selection, multi-series toggles). The sparkline is the minimal honest answer.

## References

- `.scratch/v1.5-snapshot-ui/` — ticket breakdown
- ADR 0003 — attribute references in snapshots (orphan handling)
- ADR 0005 — L4 snapshot storage (what `data.snapshots[]` contains)
- ADR 0006 — multi-page Web architecture (page vs view; mode-switched UI on one page)
- ADR 0009 — v1.1 schema; additive-field migration strategy (snapshot_cap is additive, no schema version bump)
- ADR 0010 — v1.2 testing safety net (`lib/` source of truth, thin shims)
- ADR 0011 — deletion log (snapshot deletions reuse `Records.recordDeletion`)
- ADR 0012 — backup architecture (backups is rollback; snapshots is history)
- ADR 0013 — target-allocation plans (plans excluded from snapshots; snapshot drift history is open fog)
- `CONTEXT.md` — glossary entries for *Snapshot*, *Snapshot totals*, *Snapshot delta*, *Snapshot cap*
- `lib/snapshot.js` — pure engine + v1.5 helpers (`pushSnapshotWithCap`, `normalizeSnapshotCap`, `resolveAttributeRef`, `toDisplaySeries`)
- `lib/format.js` — pure format helpers (`deltaPercent`, `convertCurrency`)
- `tests/snapshot.test.js`, `tests/format.test.js`, `tests/browser/snapshots.spec.js` — test coverage
