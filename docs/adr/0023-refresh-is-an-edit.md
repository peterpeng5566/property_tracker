# 0023 — Refresh is an edit for sync merge

## Status

Accepted (v1.16)

## Context

v1.12 sync auto-pull (commit `8ed4e74`) added a Google Drive auto-pull:
when `syncStatus` rises to `connected`, the device automatically pulls the
remote portfolio and merges it via `window.Sync.mergePortfolios` (ADR 0004,
per-record `Newer-wins merge`). The mechanism itself works — verified by
`tests/browser/_sync_auto_pull*.spec.js` and by end-to-end repro in
`.scratch/v1.12-sync-auto-pull/issues/01-open-does-not-pull-latest-from-drive.md`.

A residual symptom remained: after Refresh on device A, the new price does
not always propagate to device B even though both sides are connected and
the v1.12 pull fires on B. Manual reconnect eventually heals it, but the
auto-pull path silently delivers a stale price.

### Root cause

`_applyRefreshResult(targetSet, results, res)` (portfolio.html:3964) updates
four price fields per holding on a successful Yahoo fetch:

```
h.current_price = r.current_price;
h.high_52w      = r.high_52w;
h.low_52w       = r.low_52w;
h.prev_close    = r.prev_close;
```

It does NOT touch `holding.updated_at`. So a holding's `updated_at` reflects
whatever the last manual edit was — typically the `cost` field write at
holding creation.

`mergeById` (lib/sync.js) breaks ties strictly on `>`. When Refresh
doesn't bump `updated_at`, the refresh-time price drift has nowhere to
register: local and remote carry the same `updated_at`, local wins, the
remote's fresher price is silently dropped.

### Reproduction (verified with user portfolio data)

Holding `00631L.TW` (`holdings[].id = h-1786160340886-tdoi`):

- local `current_price = 34.81`, `updated_at = 2026-08-16T03:22:02.441Z`,
  no `prev_close` / 52w fields (cost-edit artifact)
- 5 cloud backups, all share `updated_at = 2026-08-16T03:22:02.441Z`,
  have `current_price` ∈ {35.69, 35.69, 33.96, 33.96, 34.81}
- `mergePortfolios(local, remote, 'web-qhx2ftn2')` returns
  `current_price = 34.81` every time — the local value

Snapshot history confirms the true close on 08-19 was 33.96, but local
`holdings[].current_price` stays at 34.81 (08-18 close) until manual Refresh.

## Decision

Refresh is treated as an edit. `_applyRefreshResult` bumps per holding
on **successful** fetch:

```
h.updated_at = new Date().toISOString();
h.device_id  = DEVICE_ID;
```

Failed fetches (in the `else` branch) leave both fields untouched and
flip the in-memory `_refresh_failed` flag (which `Serialize.stripInMemoryFields`
removes at `save()`; ADR 0009 §4 unchanged).

After this lands, the v1.12 auto-pull correctly propagates fresher prices
across devices without any further changes — the underlying problem was
a single missing `updated_at` bump.

### Why edit, not a new field?

A `refreshed_at` sibling would add a schema dimension without buying merge
benefit: `mergeById` would still need to compare timestamps per record, and
two clocks next to each other invites "which one wins?" confusion.
Recasting Refresh into the existing edit clock is the smallest change that
fixes the bug.

### Why not a "refresh-only sync channel"?

A separate pull-on-refresh path would duplicate v1.12's auto-pull mechanism
for no semantic gain. The whole point of the per-record merge design is to
NOT need a per-feature sync pipeline — every mutation joins the same clock.

### Why not backfill pre-v1.16 portfolios?

Considered a one-time migration that stamps held-in-stale-state holdings to
`meta.last_synced_at`. Rejected as over-engineering for the ~12-holding
user portfolio. After upgrading, a manual Refresh on each affected holding
(or on the whole portfolio) bumps `updated_at` and unblocks the auto-pull.
Documented as a known limitation in
`.scratch/v1.16-refresh-is-an-edit/issues/01-refresh-is-an-edit.md`.

## Consequences

### Snapshot's internal `holdings[].updated_at` reflects refresh-time, not snapshot-date

`lib/snapshot.js:115` deep-copies `portfolio` via
`JSON.parse(JSON.stringify(portfolio))`. After Refresh, when the user takes
a snapshot, the snapshot's internal `holdings[].updated_at` reflects the
most recent successful refresh, which can be earlier than the snapshot's
`date`.

This is **intentional** — the snapshot is a faithful record of "what live
data looked like at this moment", and the refresh-time is the actual
last-write timestamp of that record. `computeDelta` (lib/snapshot.js:88-89)
uses `priceDelta` only, so functional impact is zero. Documented
behaviour: viewing snapshot internals shows "as of last refresh", not
"as of snapshot date".

### `_refresh_failed` semantics unchanged

The in-memory-only flag `holding._refresh_failed` (ADR 0009 §4) is still
set only on failure, still stripped at `save()`, still drives the amber
row badge and "Retry N failed" button. The new bump logic for the success
path coexists cleanly — only the `if` branch touches `updated_at` /
`device_id`.

### Manual edit vs system-triggered refresh

The merger sees both as identical "an edit happened". The user-facing
distinction lives elsewhere:

- `settings.updated_at` still bumps only at edit-path stamps (ADR 0016 §6)
- `holdings.updated_at` now bumps at: (1) manual field edits via the
  holding modal (line 4696), (2) `toggleInactive` (line 4696), and
  (3) **successful Refresh fetches** (this ADR).

Both (1)/(2) and (3) participate in per-record newer-wins merge
identically. The originating trigger is recorded in
`meta.device_id` for forensics.

### Refresh-not-bumping-when-cancelled

If `res.cancelled === true` (user backed out mid-refresh), `_applyRefreshResult`
still runs with whatever partial results are already in `results`. Holdings
that succeeded before cancel get the bump; failed ones don't. The v1.15
silent-cancel contract (no toast) is preserved. Saves/pushes from a cancelled
refresh carry the partial success only — the user explicitly asked for it.

## References

- ADR 0004 — per-record newer-wins merge (semantic the fix relies on)
- ADR 0009 — refresh + in-memory flag conventions
- ADR 0016 — settings edit-path stamp trigger (sibling concern; unchanged)
- ADR 0022 — v1.15 refresh completion toast (sibling concern; unchanged)
- `.scratch/v1.16-refresh-is-an-edit/issues/01-refresh-is-an-edit.md`
- `tests/browser/v17-sync.spec.js` — v1.16 stamp trigger sibling test
- `portfolio.html:3964` — `_applyRefreshResult`
