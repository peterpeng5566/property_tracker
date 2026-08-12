# 0012 — Two-layer backup as safety net for true delete

## Status

Accepted (v1.3)

## Context

[ADR 0011](0011-true-delete-deletion-log.md) introduces true delete: a record is hard-deleted from the array and a tombstone is appended to `data.deletions[]`. The data model is now honest about user intent (Delete and Inactive are separate concepts), but a personal financial tracker that deletes records for good without a recovery path is unacceptable. A misclicked delete, an overzealous bulk-remove, or a corrupted sync is unrecoverable without a snapshot to roll back to.

The user's grill round 5 distilled this into "5 cloud backups as safety net" — bounded in count, automatic in trigger, visible in the UI. The v1.2 testing safety net ([ADR 0010](0010-v1.2-testing-safety-net.md)) protects the new code from regressions at commit time; this ADR protects the user's data from the same operation class (accidental hard-delete) at runtime.

The two layers exist because there is no single storage path that covers all failure modes:

- **Single device + Drive auto-sync on**: the Drive file is the source of truth; Layer 2 (Drive file backups) covers recovery from a bad sync. Layer 1 (in-portfolio backups) is redundant.
- **Single device + auto-sync off**: the localStorage is the source of truth; Layer 1 is the only recovery path. Layer 2 doesn't trigger because Drive isn't being written.
- **Multi-device**: Layer 1 syncs across devices via `mergeById` on `data.backups[]`; the user sees the global 5 newest backups regardless of which device created them. Layer 2 only sees backups created on the current device (Layer 2 is local to the Drive folder the device writes to).
- **localStorage wipe / browser profile corruption**: Layer 1 is gone with localStorage; Layer 2 in the Drive folder is the only recovery path.

Layer 1 + Layer 2 are defense in depth. Either layer alone leaves gaps.

## Decision

### 1. Layer 1 — in-portfolio `data.backups[]` (FIFO 5)

A new array on `data`: `data.backups[]`, holding snapshots of the portfolio. Triggered by every call to `save()` (in `portfolio.html`). FIFO 5: after each push, sort by `saved_at` and truncate to the 5 newest.

Snapshot entry shape:

```js
{
  id:        'bck-<uuid>',       // unique id for this snapshot
  saved_at:  '2024-06-15T...',   // ISO timestamp at push time
  device_id: 'dev-...',          // which device pushed it
  data:      {                   // the user-visible portfolio at push time
    version: '1.1',
    settings: {...},
    holdings: [...],
    cash_accounts: [...],
    debts: [...],
    snapshots: [...],
    // intentionally NO `backups[]` or `deletions[]` here:
    //   `backups`  is re-derived on restore (current + self-protection entry)
    //   `deletions` is preserved as a top-level field on the snapshot entry itself
  },
  deletions: [...],              // the deletion log at push time, preserved on restore
}
```

The `data` field excludes `data.backups` to prevent nesting-infinite (a backup of a backup would otherwise embed the whole history). `deletions` is preserved as a top-level field on the snapshot entry so restore can re-apply the deletion log state at backup-time.

The push logic (`lib/backup.js pushBackup`):

```js
data.backups.push(snapshot);
data.backups.sort((a, b) => Date.parse(a.saved_at) - Date.parse(b.saved_at));
data.backups = data.backups.slice(-5);
```

Trigger in `portfolio.html`: `save()` calls `Backup.buildBackupSnapshot(this.data)` and `Backup.pushBackup(this.data, snapshot)` *before* persisting to localStorage. The snapshot is of the pre-save state, not the post-save state.

### 2. Layer 2 — Drive file backups (FIFO 5)

A second copy of the snapshot, written to the same Drive folder as the live `portfolio.json`, with the filename convention:

```
portfolio-backup-{device-id}-{ISO-timestamp}.json
```

The filename embeds `device-id` and `ISO-timestamp` so a multi-device user can tell which device pushed each backup and when, and so files sort lexicographically by time (ISO 8601 sorts correctly as a string).

Triggered by every call to `writePortfolioFile()` (in `portfolio.html`). Order:

1. Read the current Drive file (the one about to be overwritten) — same `fetch` pattern as the current `writePortfolioFile` GET step.
2. Snapshot it into a new `portfolio-backup-{device-id}-{ISO-timestamp}.json` file via `Backup.writePortfolioBackupFile` (POSTs to the Drive write endpoint with `?backup=1&device_id=...&ts=...` query string).
3. Call `Backup.cleanupOldBackups(fileId, 5)` to enforce FIFO 5 — sorts the backup file list by `modifiedTime`, deletes the oldest until the count is `5 - 1` (so the upcoming write makes it `5`).
4. Proceed with the existing `PUT portfolio.json` overwrite.

Cleanup is **before** the new write, not after. The FIFO is exact after every push, not "eventually consistent after the next push."

Layer 1 also runs on this path because `save()` is called before `writePortfolioFile()` in the call chain. Both layers fire on every Drive write; the user gets two copies of every save (one local, one cloud) automatically.

### 3. Self-protection on restore

Restoring a backup is itself a destructive operation (it overwrites the current state). To make restore undoable, the current state is captured as a new backup before the restore applies:

1. Compute self-protection entry: `Backup.buildBackupSnapshot(this.data)` (current state).
2. Push self-protection entry into `this.data.backups` (FIFO 5 truncation applies; the self-protection may evict the oldest backup if `data.backups` was already at 5).
3. Compute restored `data` from the named backup:
   - `data.holdings` / `cash_accounts` / `debts` / `snapshots` / `settings` / `version` ← `backup.data`
   - `data.deletions` ← `backup.deletions`
   - `data.backups` ← unchanged (step 2 already pushed the self-protection entry)
4. `this.data = restored`.
5. `this.save()` (triggers Layer 1 again — the next snapshot is the post-restore state, which is fine).
6. `await this.writePortfolioFile(...)` (triggers Layer 2 again — snapshots the now-restored state, then overwrites).

The user can restore-restore to undo: click Restore on the most recent backup (which is the self-protection entry from step 2), and the pre-restore state returns.

### 4. Restore semantics is full-state, not diff

A restore replaces the current portfolio with the backup's snapshot wholesale. It does not merge, does not diff, does not "apply selectively." Rationale:

- The snapshot already contains everything needed to restore the user-visible state (collections, settings, deletion log). A diff-based restore would require tracking what changed since the backup, which is unbounded state we don't keep.
- The user clicked Restore; their intent is "go back to this point in time," not "cherry-pick fields."
- Snapshots history rewinds along with everything else (per the spec's *Restore* glossary term: "the data is the backup, not a diff"). A snapshot taken after the restore-target is preserved as data but is no longer "current" history.

### 5. Multi-device sync of `data.backups[]`

`data.backups[]` syncs across devices via `mergeById` (per [ADR 0004](0004-per-record-timestamp-merge.md)). The merge follows the same rule as records: per-snapshot, the newer `saved_at` wins; tie → local. Result: the global 5 newest backups across all devices are visible on every device, regardless of which device created them.

The `device_id` field in each snapshot entry disambiguates origin in the Backups page UI. The FIFO 5 truncation happens after the merge, so each device shows the same 5 rows.

Layer 2 does NOT sync across devices via this mechanism — Layer 2 files live in the Drive folder, which is the single source of truth shared by all devices. The list of Layer 2 files is read from Drive at Backups page mount time.

### 6. Pure logic in `lib/backup.js`

All six functions of the backup architecture live in `lib/backup.js`:

- `buildBackupSnapshot(data)` — produces the snapshot entry shape above.
- `pushBackup(data, snapshot, maxKeep = 5)` — in-place Layer 1 push with sort + truncate.
- `restoreFromBackup(data, backupId)` — returns `{data, selfProtectionEntry}` for the Alpine shim.
- `writePortfolioBackupFile(fileId, content, {fetchFn, deviceId, timestamp})` — Layer 2 write with `?backup=1` query string.
- `listPortfolioBackupFiles(fileId, {fetchFn})` — Layer 2 list filtered by `portfolio-backup-*.json`.
- `cleanupOldBackups(fileId, keep = 5, {fetchFn})` — Layer 2 FIFO enforcement *before* the upcoming write.

`fetchFn` is injected (per the `lib/refresh.js` pattern from [ADR 0010 §4](0010-v1.2-testing-safety-net.md)) so Node tests don't depend on a live Drive API. The Alpine shim wires `fetchFn: window.fetch`.

The Alpine methods (`save()`, `writePortfolioFile()`, `restoreFromBackup()`) remain thin shims — one call into `lib/backup.js` plus reactive bookkeeping. This satisfies AGENTS.md's "Pure logic in `lib/`; Alpine is thin shim" rule.

### 7. Recovery UX — Backups page in nav

A new top-level nav entry, "Backups" (over the alternatives of hiding under Settings or providing no UI). The page lists all available backups (5 Layer 1 + 5 Layer 2 = up to 10 rows) with:

- Timestamp (formatted for the user's locale)
- Device-id badge (so the user can tell which device pushed the backup)
- Source badge ("Local" or "Cloud")
- Restore button

The page renders into the existing nav (`<template x-if="activePage === 'backups'">`). Empty state: "No backups yet. Backups are saved automatically on every change."

Restore button triggers a `window.confirm()` (matching the existing pattern in `removeHolding` for non-modal dialogs) that states which backup is about to apply ("Restore backup from {timestamp} on {device}? Your current state will be saved as a new backup first."). Success shows a transient toast (matching the existing refresh-status banner pattern).

Rationale for "in nav, not under Settings": backups are a primary recovery path the user might need in an emergency. Hiding them under Settings requires two clicks to reach. The grill round 5 explicitly weighed this trade-off and chose the top-level nav.

## Consequences

### Positive

- True delete is safe: the user can always roll back to a recent snapshot via the Backups page.
- Bounded storage: 5 + 5 = at most 10 backups on disk; the FIFO enforcement happens before each write so the count is exact, not eventually consistent.
- Defense in depth: Layer 1 covers local/offline/auto-sync-off; Layer 2 covers cloud/multi-device/localStorage-wipe. Neither alone is sufficient.
- Self-protection makes restore undoable: the user can restore-restore to recover from a bad restore.
- Full-state restore is simple to reason about: "the data is the backup, not a diff" matches user mental model.
- Multi-device backups merge to a single coherent 5-row list per device, not 5-per-device.
- Pure logic in `lib/backup.js` keeps the architecture testable in Node; the Drive endpoint is exercised only in browser smoke.

### Negative / known limitations

- **Storage cost ~5 backups × portfolio size.** For a personal portfolio with ~50 holdings and a handful of cash/debts, this is ~50 KB per backup × 10 = ~500 KB. Negligible for personal use.
- **No cross-device sync of Layer 2.** Layer 2 files exist only in the Drive folder the device writes to. A user with two Drive folders (e.g. personal + work) writes to one at a time and loses the other folder's backups on switch. This is documented; the design assumes a single Drive folder per user.
- **The 5-most-recent rule can evict a meaningful backup.** A user who makes one change a day for 5 days will see the day-1 backup evicted by the day-5 backup. The 5-deep window is intentional (matches the user's "5 cloud backups" request) but documented here.
- **Restore is full-state, not selective.** A user who wants to keep today's new holding but restore last week's snapshot of everything else cannot cherry-pick. The trade-off is simplicity; selective restore is a future ticket if requested.
- **Layer 2 cleanup is before-write, not after-write.** If `cleanupOldBackups` succeeds but the new write fails, the count is `keep - 1` until the next successful write. Not "eventually consistent"; documented.
- **Self-protection can evict the oldest backup.** If `data.backups` is already at 5 when the user clicks Restore, the self-protection entry pushed in step 2 of the restore flow evicts the oldest existing backup. The user may not expect this; documented here for the Backups page UX.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Two layers (Layer 1 + Layer 2) | More code; either alone leaves gaps |
| FIFO 5 per layer | Bounded storage; the 6th-newest is evicted immediately |
| Cleanup before new write (Layer 2) | FIFO is exact after every push; if write fails, count is `keep - 1` |
| Self-protection on restore | A restore consumes a backup slot; the user may evict an older backup by restoring |
| Full-state restore | Simple; user cannot cherry-pick fields |
| `data.backups[]` syncs via `mergeById` | Global 5 newest across all devices; per-device 5 would be redundant |
| Layer 2 does NOT sync (lives in Drive folder) | Single Drive folder assumed; cross-folder is out of scope |
| Pure logic in `lib/backup.js` + `fetchFn` injection | One new module; Node-testable; browser smoke covers the live Drive endpoint |
| Backups page in nav (over Settings) | One extra nav entry; matches the "emergency recovery" mental model |

## Alternatives considered

- **No backup layer; trust the deletion log + restore-from-remote.** Reasons rejected: the deletion log only protects against *future* resurrection, not against "I deleted the wrong record two minutes ago." The user's grill explicitly asked for a recovery path.
- **Single Drive file backup (no Layer 1).** Reasons rejected: doesn't cover offline / auto-sync-off scenarios. A user without auto-sync has no Drive file to back up; the entire recovery story collapses.
- **Single Layer 1 (no Layer 2).** Reasons rejected: doesn't cover localStorage-wipe / multi-device Drive folder scenarios. The user's "5 cloud backups" was an explicit grill outcome.
- **Backups under Settings sub-menu.** Reasons rejected: hides the recovery path; the grill weighed this and chose the top-level nav. Backup recovery is a primary action, not a configuration knob.
- **No UI; backups are filesystem-only.** Reasons rejected: the user must be able to see and act on backups without leaving the app. Otherwise the safety net is invisible and unused.
- **Diff-based restore.** Reasons rejected: requires unbounded "what changed since this backup" state we don't keep; user mental model is "go back to this point in time," not "apply selective fields."
- **Sync Layer 2 across devices via `data.backups[]`.** Reasons rejected: Layer 2 files live in the Drive folder (single source of truth); the in-portfolio `data.backups[]` already carries the merged multi-device view. Adding Layer 2 to the in-portfolio merge would duplicate state.
- **Garbage-collect old backups beyond FIFO 5.** Reasons rejected: the FIFO 5 is the user's explicit request; GC beyond 5 changes the contract. Out of scope.
- **Cleanup after new write (Layer 2).** Reasons rejected: makes the FIFO eventually consistent (count is `keep + 1` between the new write and the cleanup), complicating the "exactly 5 backups in Drive" mental model. Cleanup-before is exact after every push.

## References

### Internal

- [ADR 0010 — v1.2 testing safety net](0010-v1.2-testing-safety-net.md) — the pre-commit gate and `lib/` extraction pattern this ADR extends; `fetchFn` injection is per §4
- [ADR 0011 — True delete via deletion log](0011-true-delete-deletion-log.md) — the true-delete change this ADR provides a recovery path for
- [ADR 0004 — Per-record timestamp merge](0004-per-record-timestamp-merge.md) — `mergeById` is the merge primitive used for `data.backups[]` cross-device sync
- [ADR 0007 — v1 Web storage: localStorage](0007-v1-web-storage-localstorage.md) — localStorage as the storage choice that constrains Layer 1 to in-portfolio
- [ADR 0009 — v1.1 price tracking](0009-v1.1-price-tracking.md) — the prior art for `fetchFn` injection in `lib/refresh.js`
- [`CONTEXT.md`](../../CONTEXT.md) — the glossary entry for *Backup* this ADR documents
- [Spec v1.3 — True Delete with Backup Safety Net](../v1.3-spec.md) (in `.scratch/v1.3-true-delete-with-backups/spec.md`) — full requirements; this ADR is the architectural distilled

### External

- Spec v1.3 §Module: `lib/backup.js` — the six functions and their contracts
- Spec v1.3 §User Stories 8–17 — the Layer 1 / Layer 2 user stories this ADR fulfils

### Wayfinder decisions

This ADR captures the architectural decision from the v1.3 grilling session (9 rounds + spec + 5 tickets at `.scratch/v1.3-true-delete-with-backups/`). The two-layer split, FIFO 5 per layer, self-protection on restore, and Backups-page-in-nav are explicit grill outcomes (rounds 3, 4, 5).