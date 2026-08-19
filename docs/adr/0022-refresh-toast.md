# 0022 — Refresh completion feedback: layered (success toast / partial warning toast / error banner)

## Status

Accepted (v1.15)

## Context

Pressing the **Refresh** button in the header drives a Yahoo refresh that can take 30+ seconds (5 retry attempts with exponential backoff: 1s, 2s, 4s, 8s, 16s). The button label transitions through three visible states:

- `idle` → `Refreshing...` (sky blue button while the loop is running).
- `partial` → amber `Retry N failed` button after the loop exhausts with failures.
- `error` → rose banner at the top of the page (when the proxy is misconfigured).

When the loop completes **successfully** (`idle` after all symbols fetched) or **partially** (`partial` after some symbols failed), the only signal to the user is the button's quiet label flip back to `Refresh`. Users reported this as a silent path — particularly when they pressed Refresh from a non-Holdings page (Snapshot, Rebalance, Cash & Debts), where the price update is **invisible** because the page isn't showing live prices.

Backup restore already solved the same problem for its own async path: a 5-second bottom-center toast via `window.__toast.show(message, variant)`, with `success` (emerald) / `error` (rose) / `warning` (amber) variants. The infrastructure is in `portfolio.html:6263-6296` — a separate `toastScope()` Alpine component driven via a `window.__toast` bridge, so the toast state survives even when the portfolio() async method throws (the rollback case).

The architectural question is **how to layer the feedback**: which outcomes deserve which strength of notification?

## Decision

### 1. Three feedback layers, one bridge

| Outcome | Channel | Variant | Why |
|---|---|---|---|
| All success | toast (5s, bottom-center) | success (emerald) | Silent happy path is invisible to users on non-Holdings pages; success toast surfaces "5 holdings updated" without occupying the page. |
| Partial | toast (5s) **+** persistent amber button | warning (amber) | User needs both: the toast is the "we tried, some failed" notification, and the amber `Retry N failed` button stays visible until they retry or re-refresh. |
| Full fail / proxy not configured | rose banner (persistent until dismiss) | error (rose) | Unchanged from pre-v1.15. The banner is the strongest signal — it occupies the top of the page and demands attention. |
| Cancelled mid-flight | silent | — | Cancellation is a user action, not an outcome; a toast would feel like the system apologizing for itself. |
| 0 active holdings | silent | — | The refresh is a no-op (`targetSymbols.length === 0` early-returns); no work was attempted, no notification is appropriate. |

The toast uses the **existing** `window.__toast.show(message, variant)` bridge (`portfolio.html:6263`). No new UI surface, no new toast component.

### 2. Toast content carries a count, not a list

- `Refreshed {n} holdings` / `已更新 {n} 個標的` (success).
- `Refreshed {n} of {total} holdings, {m} failed` / `已更新 {total} 個標的中的 {n} 個，{m} 個失敗` (partial).

Ticker lists are deliberately omitted. The user already sees the failing tickers in the Holdings table's red `tr.refresh-failed` badge + amber Retry button. Repeating them in a 5-second toast is visual noise (a 30-holding portfolio with 25 failures would wrap a 3-line toast on a 320 px viewport).

**Rejected**: include ticker list. See above.

**Rejected**: omit the count, just say "Refreshed" / "Some failed". Loses the sanity-check value: "did I just update 5 holdings, or was it 0?".

### 3. Fire from `_applyRefreshResult`, not `refreshAllPrices`

The fire point is at the end of `_applyRefreshResult(targetSet, results, res)` in `portfolio.html:3958`, **after** the existing `this.save(); this.scheduleAutoPush();` block. Rationale:

- `_applyRefreshResult` is the single source of truth for "refresh completed — publish the result". It already sets `refreshState`, mutates `this.data.holdings`, and persists. Adding "announce" is the same responsibility.
- The retry path (`retryFailed()` → `refreshAllPrices(this.refreshFailures)` → `_applyRefreshResult`) automatically gets the same announcement with the **retry scope** as `targetSet.size`, not the full portfolio. Test T6 pins this contract.
- Skip rules are simple: `if (!res.cancelled && res.attempts > 0)`. Cancelled = silent; no work attempted = silent.

**Rejected**: fire from `refreshAllPrices` after the `await Refresh.runRefresh(...)`. Adds a fire-point call to two paths (the main path and `retryFailed`'s delegated call) instead of one. `_applyRefreshResult` already runs after both.

**Rejected**: fire from the Alpine `x-show` watcher on `refreshState`. The watcher would fire on **every** state transition (including `refreshing` → `partial`), losing the "completion" semantics and complicating the count-source decision.

### 4. i18n lives under `header.*`

`header.refreshToastSuccess` / `header.refreshToastPartial`. Sits next to the existing `header.refresh` / `header.refreshing` / `header.refreshError` keys (`portfolio.html:2837`). The "refresh" action's strings are concentrated in `header.*`, so the toast keys belong to the same family.

**Rejected**: new `refresh.*` namespace. The refresh action's UI strings are already scattered (button labels in `header.*`, error tooltip in `holdings.*`); opening a new namespace fragments them further without semantic gain.

### 5. No new glossary entry in CONTEXT.md

`toast` is a UI pattern, not a domain concept. The `window.__toast.show(...)` inline comment (`portfolio.html:6263`) self-documents the bridge; backup restore's existing use provides a worked example. CONTEXT.md entries pin down domain concepts (e.g. v1.14's "Display currency" entry for the act-vs-measure rule); UI patterns don't belong there.

**Rejected**: add a "Refresh notification" or "Refresh toast" glossary entry. No new domain concept; entry would be cosmetic.

## Consequences

- **5s toast overlap with page content** is the same behavior as the existing backup restore toast. The toast is `position: fixed bottom-6 z-50`, so on mobile (320/375/414 px) it briefly overlays the bottom card during its 5s display. Verified visually in Round 2 — acceptable, matches the restore-toast pattern. The iOS home-indicator bottom-edge gap (~34 px) is pre-existing on the restore toast and not a v1.15 regression.
- **`header.refreshError` (rose banner) stays unchanged**. The Q3 P1 layering keeps the banner as the strongest signal for "the whole refresh couldn't run" (proxy misconfigured, no URL, etc.), and uses the toast for the more common "it ran, here are the results" cases.
- **`onAttempt` callback unchanged**. The existing onAttempt captures `lastResults` for `_applyRefreshResult` to apply after the loop; v1.15 adds the announcement at the end, not per-attempt (per-attempt toasts would spam the user during 5 retry attempts).
- **No schema bump**. Toast wiring is pure UI; `lib/` is unchanged.
- **Tests**: `tests/browser/refresh-toast.spec.js` (6 tests) pins the contract at the `data-testid="restore-toast"` DOM seam. T3/T4/T5 are guardrails (silent paths) that pass even before implementation but would fail if a future change accidentally fired a toast in those paths.

## Alternatives considered

- **Banner for success too** — visually overwhelming. Success is the common case (no proxy misconfiguration, network is fine, Yahoo returns quotes); the user does not need a banner every refresh. Toast is the right intensity.
- **Status icon in header** (e.g. a momentary green dot on the refresh button). Adds a new UI element for marginal gain over the toast. The button already transitions to "Refreshing..." sky blue during the loop; another flash on success is redundant.
- **`Last refreshed at <time>` persistent label**. Useful, but a separate design decision (Q1 D — not chosen). Could be added in a later version without changing v1.15's design.

## References

- `.scratch/v1.15-refresh-toast/issues/01-refresh-toast.md` — design ticket with the Round 1–3 decision tree.
- `lib/refresh.js` — pure refresh state machine (runRefresh returns `{attempts, succeeded, failed, cancelled}`).
- `portfolio.html:6263-6296` — `toastScope()` + `window.__toast` bridge.
- `portfolio.html:3958` — `_applyRefreshResult` (fire point).
- `tests/browser/refresh-toast.spec.js` — T1–T6 contract tests.
- ADR 0012 — backup restore toast pattern (precedent for this design).
- ADR 0021 — act-vs-measure (separate concern: which currency to render in; v1.15 is about *whether* to announce at all).
