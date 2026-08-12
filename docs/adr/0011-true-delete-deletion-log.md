# 0011 — True delete via deletion log

## Status

Accepted (v1.3)

## Context

Commit `c434c0d` ("fix: deletion/toggle must propagate via sync (was: hard-delete)") was an intermediate fix for a sync bug: a hard-deleted record on Device A would reappear on Device B after sync, because `mergeById` only resolves per-record conflicts on records that *exist* — a deleted record is no longer in the local array, so there is nothing to compare.

The fix repurposed the *Inactive* flag as a soft-delete marker, conflating two concepts that the glossary had deliberately kept separate. The glossary entry for *Inactive* (in [`CONTEXT.md`](../../CONTEXT.md)) reads:

> **Inactive**: A state a holding can be in when it has been delisted or otherwise retired. Inactive holdings are not counted in totals but remain in the portfolio for history. _Avoid_: **Deleted** (sounds destructive)

The glossary was right; the code should match. Conflating *Delete* with *Inactive* produces three concrete failures:

1. **Glossary conflict.** Delete and Inactive mean different things. The former is "this record is gone"; the latter is "this record still exists, just retired from totals." Code that treats the former as the latter makes the data model lie about its own intent.
2. **No true undo.** A soft-deleted record has no "reactivate" affordance other than the Active/Inactive toggle, and there is no way to delete a record for good. The user's intent ("I sold this holding; it's gone") cannot be expressed in the data.
3. **Silent data bloat.** A soft-deleted record still exists. Totals stay correct, but the data carries invisible ghosts that grow without bound.

The user wants true delete. The technical problem the `c434c0d` fix tried to solve — propagating a hard-delete across devices via `mergeById` — is real: `mergeById` cannot propagate the *absence* of a record, only a divergence between two *present* records.

## Decision

### 1. `data.deletions[]` tombstone log

An additive array of `{id, target_id, type, deleted_at, device_id}` entries that records "this record was hard-deleted; do not resurrect from remote." Shape:

```js
{
  id:         'del-<uuid>',     // unique id for the tombstone itself
  target_id:  '<record-uuid>',  // id of the record that was deleted
  type:       'holdings',       // 'holdings' | 'cash_accounts' | 'debts'
  deleted_at: '2024-06-15T...', // ISO timestamp
  device_id:  'dev-...',        // which device issued the delete
}
```

The `type` field is kept (even though `data.holdings`, `data.cash_accounts`, and `data.debts` are separate arrays) so the same deletion log serves all three record-bearing collections, and any future ones (categories, attribute values, settings). One log, multiple collection types, one merge rule.

The log is **additive only**. There is no current code path that removes an entry from `data.deletions[]`. Tombstones are part of the portfolio state and sync alongside everything else via `mergeById`.

### 2. `mergeByIdWithDeletions` composes `mergeById` with a deletion-log filter

The `mergeById` helper (per [ADR 0004](0004-per-record-timestamp-merge.md)) is unaware of the deletion log; it only resolves conflicts on *present* records. The new `mergeByIdWithDeletions(localArr, remoteArr, localDeletions, remoteDeletions)` composes the two:

1. Compute the merged deletion log via `mergeById(localDeletions, remoteDeletions)`.
2. Compute the merged records via `mergeById(localArr, remoteArr)`.
3. Filter out records whose id appears in the merged deletion log.

The helper is a **separate function**, not a change to `mergeById`. Rationale: `mergeById` is a generic per-record merge rule used by data that has no deletion concept (e.g. settings — see [ADR 0009 §5](0009-v1.1-price-tracking.md)). Conflating concerns makes the helper harder to reason about and harder to test. The Alpine shim (in `portfolio.html`) does not call `mergeById` directly for `holdings` / `cash_accounts` / `debts` / `snapshots`; it calls `mergeByIdWithDeletions`.

### 3. Conflict resolution: delete always wins

After merging, any record whose id appears in the merged deletion log is removed. This holds even if the remote copy has a *newer* `updated_at` — the user's delete intent on one device supersedes a stale edit on another. Rationale:

- A click on Delete is a **high-intent, one-way user action** (per the glossary: Delete "sounds destructive"). The user does not click Delete casually; the record is meant to be gone.
- A stale edit after a delete is the cross-device bug class that `c434c0d` was trying to paper over with soft-delete. The deletion log resolves it at the data layer, not the UI layer.
- The opposite rule (delete loses to stale edit) would resurrect deleted records on next sync and require the user to re-delete, which is a worse experience than "the edit I made while you were deleting is lost."

The merge of the deletion log itself uses `mergeById`'s standard tie-break (local wins on `updated_at` tie; see [ADR 0004](0004-per-record-timestamp-merge.md)). Same-id tombstone collisions — both devices deleted the same record — collapse to a single tombstone.

### 4. Pure logic in `lib/records.js`

The record-deletion pattern (`{splice the record, append a tombstone}`) lives in `lib/records.js` as `recordDeletion(records, deletions, opts)`. The function is pure (never mutates inputs; returns `{records, deletions, didDelete}`); the Alpine shim (`portfolio.html` `_removeRecord`) assigns the returned arrays back onto `this.data`. This satisfies the AGENTS.md rule "Pure logic in `lib/`; Alpine is thin shim" and was extracted from three near-identical inline methods (`removeHolding`, `removeCash`, `removeDebt`) during the code review of commit `38ef533`.

The merge logic (`mergeByIdWithDeletions`, deletion filter for `mergePortfolios`) lives in `lib/sync.js`. Both modules are tested via `tests/records.test.js` and `tests/sync.test.js` respectively.

## Consequences

### Positive

- The data model matches the glossary: Delete and Inactive are separate concepts with separate representations.
- True delete is recoverable across devices via sync — the original bug `c434c0d` papered over is fixed at the data layer, not the UI layer.
- The pattern is generalisable: categories, attribute values, and settings can adopt the same log if they ever need cross-device true-delete propagation.
- The merge rule is one consistent rule (`mergeById`) extended by one composable concern (deletion log). No new merge primitive.

### Negative / known limitations

- **Tombstone log grows unbounded.** There is no garbage collection; every delete ever issued is in the log forever. For a personal portfolio this is negligible (deletes are rare and entries are small), but it is a known limitation. A future ticket can add time-bounded GC ("drop tombstones older than N days") if usage data shows growth.
- **Multi-device race resolves by last-write-wins on the deletion log itself.** Two devices deleting the same record at the same time collapse to one tombstone; two devices deleting *different* records at the same time both tombstones win. The rare case — Device A deletes while Device B has an in-flight stale edit that hasn't synced yet — loses the edit, which is the intended "delete always wins" behaviour but is documented here for completeness.
- **Snapshots are filtered by the merged deletion log.** A snapshot in remote that contains a record deleted on local will have that record removed on next merge. This is intended: the snapshot is a history of the portfolio *as the user currently sees it*, not as it once was. The snapshot's *totals* (the aggregate numbers) are unaffected because they were captured at snapshot-time. The Backups page UX ([ADR 0012](0012-backup-architecture.md)) lets the user inspect any past snapshot, which exposes this filtering behaviour explicitly.
- **The deletion log does not propagate "undo a deletion log entry."** Once a tombstone is in `data.deletions[]`, it stays. Recovery is via the Backup architecture ([ADR 0012](0012-backup-architecture.md)), not via the deletion log.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Separate `mergeByIdWithDeletions` helper (not bake into `mergeById`) | Two helpers to maintain; `mergeById` stays generic and pure |
| `type` field in tombstone (single log serves all collections) | Slightly larger entries; one log for all current and future record-bearing collections |
| Delete always wins | Stale edits after a delete are lost; matches user intent |
| No GC on the deletion log | Storage grows unbounded; negligible for personal use; documented |
| Pure `lib/records.js` `recordDeletion` | One new module; eliminates three near-identical inline Alpine methods |

## Alternatives considered

- **Soft-delete with `inactive` flag** (the `c434c0d` approach). Reasons rejected: violates the glossary's *Inactive ≠ Deleted* guidance; user cannot express true-delete intent; data bloat. Superseded by this ADR.
- **Per-collection tombstones** (`deletions_holdings`, `deletions_cash`, `deletions_debts`). Reasons rejected: triple the storage; three merge rules instead of one; harder to extend to future record-bearing collections.
- **Bake the deletion filter into `mergeById`.** Reasons rejected: `mergeById` is a generic per-record merge rule used by data that has no deletion concept. Conflating concerns makes the helper harder to reason about and harder to test.
- **Delete loses to stale edit.** Reasons rejected: resurrects deleted records on next sync; worse UX than "stale edit is lost"; defeats the purpose of the deletion log.
- **Garbage-collect tombstones after N days in v1.3.** Reasons rejected: out of scope; storage cost is negligible for personal use; designing GC without post-implementation evidence is over-engineering. Follow-up if usage data shows growth.

## References

### Internal

- [ADR 0004 — Per-record timestamp merge](0004-per-record-timestamp-merge.md) — `mergeById` is the merge primitive that `mergeByIdWithDeletions` composes with
- [ADR 0009 — v1.1 price tracking](0009-v1.1-price-tracking.md) §5 — the v1 limitation that categories / settings replace-from-remote (this ADR's pattern generalises to that case in a follow-up)
- [ADR 0010 — v1.2 testing safety net](0010-v1.2-testing-safety-net.md) — the `lib/` extraction and pre-commit gate that caught the duplication in three `removeX` methods during this ADR's review
- [ADR 0012 — Two-layer backup as safety net for true delete](0012-backup-architecture.md) — the recovery path that makes true delete acceptable for a personal financial tracker
- [`CONTEXT.md`](../../CONTEXT.md) — the glossary entries for *Inactive* and *Deletion log* that this ADR aligns the code with
- [Spec v1.3 — True Delete with Backup Safety Net](../v1.3-spec.md) (in `.scratch/v1.3-true-delete-with-backups/spec.md`) — full requirements; this ADR is the architectural distilled

### External

- Commit `c434c0d` ("fix: deletion/toggle must propagate via sync (was: hard-delete)") — the intermediate soft-delete fix this ADR supersedes
- Commit `38ef533` ("fix: replace c434c0d soft-delete with true delete + deletion log") — the implementation of this ADR
- Commit `0b63ed9` ("refactor: extract recordDeletion to lib/, fix deletion-merge test name") — the code-review follow-up that extracted the shared helper

### Wayfinder decisions

This ADR captures the architectural decision from the v1.3 grilling session (9 rounds + spec + 5 tickets at `.scratch/v1.3-true-delete-with-backups/`). The tombstone log shape, `mergeByIdWithDeletions` composition, and "delete always wins" conflict resolution are explicit grill outcomes (rounds 2, 6).