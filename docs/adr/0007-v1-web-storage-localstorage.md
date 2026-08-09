# 0007 — v1 Web storage: localStorage

## Status

Accepted (v1)

## Context

The v1 Web prototype needs to persist the portfolio (holdings, cash, debts, categories, settings) on the user's device between page reloads. The prototype has used `localStorage` since v0.1; `portfolio.html` carries load/save/migration/device_id machinery at lines 720, 784, 816, 779 (`this.$watch('data', …, { deep: true })` writes on every change).

The ticket is whether to **keep localStorage**, **migrate to IndexedDB**, or **skip local storage entirely** and read from Drive on every page load.

## Decision

**v1: keep localStorage** with a single key (`property_tracker_portfolio_v1`). Migrate to IndexedDB only when v1.1+ brings in data (snapshots) large enough to justify the change.

### Why localStorage

- **Data size**: v1 portfolio is ~50 KB (12 holdings + few cash + few debts + ~5 categories). 5 MB localStorage quota is 100× headroom.
- **Write pattern**: Alpine's `$watch('data', …, { deep: true })` writes on every data change. localStorage's sync API handles ~50 KB writes in <1 ms — fine.
- **Read pattern**: load once on `init()`, keep in memory. Sync API is simpler than IndexedDB's async API.
- **Query**: all queries are in-memory after load. No benefit from IndexedDB's indexes/cursors.
- **Already wired up**: `portfolio.html` has load/save/migration/device_id machinery. Migration cost is non-trivial for zero v1 benefit.

### Why not IndexedDB for v1

- No v1 data exceeds 5 MB localStorage quota.
- No v1 query needs an index.
- No concurrent-tab writes.
- Async API adds complexity for no functional gain.

### Why not no-local-storage (read from Drive every time)

- ADR 0002 establishes local copies as working state (pull-on-open, edit locally, push-on-save).
- Per ADR 0004, every record carries `updated_at` + `device_id` for client-side merge — this requires local state to accumulate edits between syncs.
- Drive is the source of truth and is the single point of failure if user is offline; localStorage is the offline working copy.

## Deferred (v1.1+)

The snapshot subsystem (ADR 0005) holds L4 full-detail snapshots — accumulating 100-500/year × 5-20 KB = 0.5-10 MB/year. When snapshots are added:

- **Option A**: store snapshots in IndexedDB alongside the localStorage portfolio (separate concerns)
- **Option B**: store snapshots in Drive only, fetch on demand from the Web app (no local snapshot cache)
- **Option C**: another answer

This is not pre-decided. Snapshot storage is a separate ticket when v1.1 work begins.

## Consequences

### Positive

- Zero migration cost for v1
- Already-shipping code continues to work
- Simple, debuggable: data visible in DevTools Application tab

### Negative

- **Pretty-printing waste**: `JSON.stringify(data, null, 2)` writes 2-3× more bytes than minified. Acceptable for v1 size; revisit if v1.1 local data grows.
- **No `try/catch` on `localStorage.setItem`**: a `QuotaExceededError` would crash the app. Acceptable for v1 size; very low risk.
- **No cross-tab `storage` event sync**: a second tab would overwrite the first tab's saves on change. Acceptable for v1 single-user; revisit if the user starts using multiple tabs.

### Trade-offs accepted

- **Pre-optimization forbidden**: defer IndexedDB migration until v1.1 local data actually exceeds localStorage. Pre-emptive migration is rejected.

## Alternatives considered

- **Migrate to IndexedDB preemptively**: re-writing load/save, migration code, schema versioning for zero v1 benefit. Rejected.
- **Skip local storage**: conflicts with ADR 0002/0004 sync model (local copy must accumulate edits between syncs). Rejected.
- **`localforage` (localStorage API on IndexedDB)**: case for migration when data grows; case for it now is weak. Rejected for v1.
- **Split across multiple localStorage keys** (e.g., separate keys for holdings/cash/debts): no query benefit since data is loaded fully into memory anyway. Rejected.
