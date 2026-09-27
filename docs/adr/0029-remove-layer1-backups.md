# 0029 — Remove Layer 1 (in-portfolio) backups

## Status

Accepted (v1.23)

## Context

[`ADR 0012`](0012-backup-architecture.md) introduced a two-layer backup architecture as the safety net for the *Deletion log* (per [`ADR 0011`](0011-true-delete-deletion-log.md)). Layer 1 — the in-portfolio `data.backups[]` array — and Layer 2 — Drive file backups — together cover the offline / auto-sync-off / multi-device / localStorage-wipe failure modes.

In practice, Layer 1 has become a liability rather than an asset:

- **File size.** `data.backups[]` occupies **~490 KB out of 605 KB (81%)** of a typical `~/portfolio_rebalance.json`. Five full snapshots × ~92 KB each are stored in every save's payload, and the field grows unbounded on disk, on Drive, in the sync wire payload, and in browser localStorage.
- **Sync latency.** Every `save()` ships the full 5-snapshot history to Drive. With Layer 2 already providing cloud-side durability, the in-portfolio copy is redundant for recovery — the only property it adds is "self-protection on restore," which the user has decided to drop.
- **Mental model.** Three sources of truth for backups (in-portfolio array, Drive file, deletion log) create a recurring question: "which one is canonical?" Removing Layer 1 collapses this to two (Drive file + deletion log) and makes the Backups page UI a single-section Cloud-only list.
- **Multi-device merge complexity.** Per [`ADR 0004`](0004-per-record-timestamp-merge.md), `data.backups[]` syncs across devices via `mergeById`. The merge introduces non-trivial edge cases (FIFO 5 truncation after merge, conflict-resolution on snapshot entries, etc.) for a payload that is never read by the restore algorithm.

The user's grill session (round 1, round 2) converged on a one-layer architecture: **drop Layer 1 entirely, keep Layer 2 as the sole backup mechanism, drop self-protection on restore, keep `data.backups: []` as an empty-array wire-format placeholder for schema compatibility.**

## Decision

### 1. `data.backups[]` is always `[]`

Layer 1 (`data.backups[]`) is removed from the schema:

- The field is **always written as an empty array** (`"backups": []`).
- The field is **never read with content** — readers see `[]` and skip.
- The wire-format `"backups": []` (14 bytes per save) is preserved for backward compatibility with older clients that still read this field.

Rationale: the alternative — dropping the field entirely — breaks wire-format compat. The 14-byte cost is acceptable.

### 2. Layer 2 is the sole backup mechanism

Layer 2 (Drive file backups) is unchanged:

- Filename convention: `portfolio-backup-{device-id}-{ISO-timestamp}.json`.
- Stored in the same Drive folder as `portfolio.json`.
- FIFO 5 per Drive folder, cleanup-before-write.
- Triggered by every `writePortfolioFile()` call.
- All seven Layer 2 functions in `lib/backup.js` (`writePortfolioBackupFile`, `readPortfolioBackupFile`, `listPortfolioBackupFiles`, `cleanupOldBackups`, `parseBackupFilename`, `createCloudBackupsCache`, `buildMultipartBody`) are preserved as-is.

### 3. Self-protection on restore is removed

The pre-restore snapshot push (per [`ADR 0012 §3`](0012-backup-architecture.md)) is removed:

- Restore no longer captures the current state as a new backup before applying.
- The user can still undo a bad restore by picking a different Layer 2 entry from the Drive list — the undo path is now "restore from a different Cloud backup" rather than "restore from the most-recent self-protection entry."
- The simpler restore semantics makes the Backups page UI a single-section Cloud-only list (no Local sub-section, no source badge distinguishing Local vs Cloud).

### 4. Migration: `removeLayer1Backups` clears pre-existing entries

A new migration step `Migration.removeLayer1Backups(data)` is added to `lib/migration.js`:

- Detects the old shape via `Array.isArray(data.backups) && data.backups.length > 0 && typeof data.backups[0]?.data === 'object'` (old Layer-1 entries always had a `.data` field).
- Replaces the array with `[]`.
- Idempotent — safe to run on every load.
- Wired at the same 3 call sites as `migrateAdditiveFields` (load / restore post-apply / import post-apply).
- **No schema version bump.** Additive clearing, same pattern as [`ADR 0009 §6`](0009-v1.1-price-tracking.md).

### 5. i18n and UI text updates

- `nav.backups` → `nav.cloudBackups` (en: `'Cloud backups'`, zh: `'雲端備份'`).
- `backups.subtitle` rewritten to describe Layer 2 only.
- `backups.localHeading` / `backups.sourceLocal` deleted from both en and zh blocks (the Local section is removed in the Backups page template; ticket 02 finishes the template cleanup).
- `backups.confirmRestore`, `backups.toastSuccess`, `backups.toastSyncSkipped` rewritten to drop self-protection references.

### 6. Functions removed from `lib/backup.js`

The following Layer-1 functions are **removed** (ticket 02):

- `pushBackup(data, snapshot, maxKeep = 5)` — the in-portfolio push with FIFO 5 truncation.
- `buildBackupSnapshot(data)` — the snapshot entry builder.
- `restoreFromBackup(data, backupId)` — the lookup-by-id wrapper that delegated to `restoreFromSnapshot`. With Layer 1 gone, the lookup is always empty.

`restoreFromSnapshot(data, snapshot, opts)` is **simplified**:

- The self-protection block (`selfProtectionEntry` construction, `merged.concat([selfProtectionEntry])`, `merged.sort(...)`, `merged.slice(-5)`) is removed.
- Final return: `{ data: { ...snapshot, backups: [] } }`.

## Supersedes

**Supersedes** [`ADR 0012`](0012-backup-architecture.md) in the following sections:

- **§1** (Layer 1 — in-portfolio `data.backups[]`): Layer 1 is removed; the array is always `[]`.
- **§2** first sentence (Layer 2 — Drive file backups): unchanged, but no longer "Layer 2 is a copy of Layer 1"; it's now the sole layer.
- **§3** steps 1–2 and step 5 (self-protection on restore): removed.
- **§5** first sentence (multi-device sync of `data.backups[]`): no longer applicable; `data.backups` is always `[]`.
- **§6** entries for `pushBackup` / `buildBackupSnapshot` / `restoreFromBackup`: removed.

All other sections of ADR 0012 (Layer 2 mechanics, full-state restore semantics, Backups-page UI shape, pure-logic-in-`lib/backup.js`) remain accurate and authoritative. ADR 0012 is marked `superseded by ADR 0029` in frontmatter but its body content is preserved as git history for readers who want the rationale of the two-layer architecture that this spec removes.

## Consequences

### Positive

- **File size reduction.** ~490 KB per save payload drops to ~14 bytes (the wire-format `"backups": []` placeholder). For a personal portfolio with 12 holdings + 5 cash + 1 debt + 6 snapshots, this is ~490 KB of pure overhead per save removed.
- **Simpler mental model.** Two sources of backup truth (Drive file + deletion log) instead of three (in-portfolio array + Drive file + deletion log). The "which one is canonical?" question disappears.
- **No Layer-1 multi-device merge complexity.** `mergeById` no longer has to reconcile per-snapshot entries across devices. The merge block in `lib/sync.js` collapses to a hardcoded `backups: []`.
- **Faster sync.** Save payloads shrink dramatically; the wire transmission time scales with payload size.
- **Cleaner Backups page UI.** Single-section Cloud-only list; no Local-vs-Cloud source badge, no two-row empty state, no local-restore path to test.

### Negative / known limitations

- **Loss of immediate-pre-restore undo state.** Before this ADR, restoring a backup pushed a self-protection entry first; the user could restore-restore to recover from a bad restore. After this ADR, undoing a restore means picking a different Layer 2 entry from the Drive list. The undo is still possible (Layer 2 keeps 5 backups), but the undo target is "another Cloud backup" rather than "the just-captured self-protection entry."
- **Offline / auto-sync-off users lose in-portfolio recovery.** Before this ADR, a user with auto-sync off had `data.backups[]` in localStorage as their recovery path. After this ADR, the recovery path requires Drive sync to have run at least once (Layer 2 backup file exists in Drive). The mitigation: Layer 2 captures every `writePortfolioFile()`, and a single successful Drive write populates the recovery path; the user's worst-case loss window is "between when localStorage was last synced and when the local state diverged from Drive."
- **Wire-format overhead of 14 bytes per save.** Acceptable; the alternative (omitting the field entirely) breaks wire-format compat with older clients.
- **Backups page text in commit 1 briefly shows literal key names** (`backups.localHeading`, `backups.sourceLocal`) because the i18n keys are deleted in this commit but the template is removed in ticket 02. This is a one-commit visible regression; ticket 02 deletes the template. Documented in the ticket 01 answer.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Drop Layer 1 entirely (over "make it opt-in") | One layer to maintain; "opt-in" would leave a footgun for the 90% of users who don't know about it |
| `backups: []` wire-format placeholder (over omitting the field) | 14 bytes per save; preserves backward compat with older clients |
| No schema version bump | Idempotent migration; one fewer field for older clients to discover |
| Self-protection dropped (over "make it opt-in") | Drive list still offers undo-restore via a different Layer 2 entry |
| `removeLayer1Backups` as a separate exported function (over folding into `migrateAdditiveFields`) | `migrateAdditiveFields`'s file header declares "all migrations here are ADDITIVE"; subtractive migration stays separate to honour that invariant |
| Migration runs on every load (over "run once and mark") | Idempotent; no flag field needed |
| Two-commit split (docs + i18n first, code second) | Smaller, reviewable diffs; rollback is per-commit |

## Alternatives considered

- **Keep Layer 1, but make it opt-in.** Reasons rejected: footgun for the 90% of users who don't know about it; the 81% payload cost is paid by everyone regardless; opt-in toggles tend to accumulate over time.
- **Reduce Layer 1 FIFO to 1 (single self-protection entry only).** Reasons rejected: still 1 full snapshot per save (~92 KB); doesn't reduce the multi-device merge complexity; the use case (undo-restore) is covered by the Layer 2 list.
- **Drop the `data.backups` field entirely (no wire-format placeholder).** Reasons rejected: breaks wire-format compat with older clients that still read this field. The 14-byte cost is acceptable.
- **Schema version bump to 1.23.** Reasons rejected: the field is preserved (`[]`), so the schema doesn't change. An additive clearing migration (same pattern as ADR 0009 §6) is sufficient and idempotent.
- **Fold `removeLayer1Backups` into `migrateAdditiveFields`.** Reasons rejected: `migrateAdditiveFields`'s file header declares "all migrations here are ADDITIVE"; a subtractive migration would violate that invariant and make the file's mental model harder to reason about. Two sibling functions, each with a clear semantic, is better than one mixed-mode function.
- **Keep self-protection as an opt-in.** Reasons rejected: the Drive list still offers undo-restore via a different Layer 2 entry; the use case is covered. Self-protection adds code complexity (pre-restore snapshot push + catch-block re-attach on rollback) for marginal benefit.
- **Delete the `data.backups` template, i18n keys, and shim comments all in one commit.** Reasons rejected: ~1000-line diff is un-reviewable. Two-commit split keeps each diff reviewable and lets the rollback be per-commit if needed.
- **Update `lib/sync.js` to omit the field on write.** Reasons rejected: breaks wire-format compat. Hardcoding `backups: []` is cheaper and equivalent for v1.23+ clients.

## References

### Internal

- [`ADR 0010`](0010-v1.2-testing-safety-net.md) — the pre-commit gate (`./scripts/safety-net.sh`) and `lib/` extraction pattern that this ADR's two-commit split follows.
- [`ADR 0011`](0011-true-delete-deletion-log.md) — the *Deletion log* whose recovery story Layer 1 used to support. Unchanged by this spec.
- [`ADR 0012`](0012-backup-architecture.md) — superseded by this ADR in §1, §2 first sentence, §3 steps 1-2 and 5, §5 first sentence, §6 entries for `pushBackup` / `buildBackupSnapshot` / `restoreFromBackup`.
- [`ADR 0004`](0004-per-record-timestamp-merge.md) — `mergeById` is the merge primitive that Layer 1's multi-device sync used. Unchanged by this spec.
- [`ADR 0009`](0009-v1.1-price-tracking.md) §6 — the additive-clearing migration pattern that this spec's `removeLayer1Backups` follows (no schema version bump).
- [`CONTEXT.md`](../../CONTEXT.md) — the *Backup* glossary term is narrowed by this spec.
- [Spec v1.23 — Remove Layer 1 backups](../v1.23-remove-layer1-backups/spec.md) (in `.scratch/v1.23-remove-layer1-backups/spec.md`) — full requirements; this ADR is the architectural distilled.

### External

- Spec v1.23 §Glossary — the narrowed *Backup* / *Layer 2 backup* / *Restore* definitions.

### Wayfinder decisions

This ADR captures the architectural decision from the v1.23 grilling session (2 rounds + spec + 2 tickets at `.scratch/v1.23-remove-layer1-backups/`). The two-commit split (docs + i18n first, code second), the wire-format placeholder, and the migration step placement are explicit grill outcomes (Q3, Q9, Q10 in the grilling rounds).
