# 0016 — Categories + Settings sync merge (replace-from-remote → proper merge)

## Status

Accepted (v1.7)

## Context

ADR 0009 §5 documents a v1 limitation: `data.categories` and `data.settings` cannot be merged field-by-field because they lack per-record `updated_at`. The temporary workaround is `replace-from-remote when present, fall back to local`. This was acknowledged as a known limitation and explicitly listed as a follow-up in ADR 0011's "References" section.

In practice, this workaround has a real user-visible bug:

> A user added a new category on Device B. After auto-sync pulled Drive state on Device A, the new category was wiped from Device A — because the user's `replace-from-remote` saw Device A's stale local and Device B's local array, and chose the wrong one.

The same bug class silently affects settings: a user who edits `fx_rate` on Device A while Device B's remote is older will see `fx_rate` revert (or, symmetrically, the reverse). There is no reported user complaint for settings yet, but the design is unsound and a future ticket will land.

The user's complaint — "there seems to be an ADR that says delete wins over newer" — surfaces a deeper issue: the merge layer doesn't know what an "add" is for categories. New categories don't tombstone themselves; they just appear in the array. Without a "newer" signal, `mergeById` degenerates to "local wins" or "remote wins" depending on the shape of the input — but the *stored* shape is `replace-from-remote`, which is neither: it's "last writer's whole array wins".

V1.7 fixes this for categories and settings using their respective primitives. Categories mirror the plans/holdings/cash/debts pattern (per-record `mergeByIdWithDeletions`). Settings gets an object-level newer-wins on a `settings.updated_at` stamp. Both are additive (`data.version` stays `'1.1'` per ADR 0009 §6).

## Decision

### 1. Categories mirror plans: per-record `mergeByIdWithDeletions`

Categories merge with `mergeByIdWithDeletions(local.categories, remote.categories, local.deletions, remote.deletions)` — the same pattern used by holdings, cash_accounts, debts, snapshots, and plans. Per-record `updated_at` is the conflict signal; the deletion log is the truth for "this record is gone".

**Rejected**: keep `replace-from-remote` for categories (status quo). The user-reported bug is the reason this ADR exists. Mirroring plans is the proven, consistent solution.

**Rejected**: per-record-merge without deletion-log. Without tombstones, a "delete" on one device would resurrect on the other (the v1.3 hard-delete bug class). The deletion log is mandatory for any record-bearing collection.

### 2. Lazy populate at load time (no save-time lazy; no schema version bump)

Each category gains two fields: `updated_at: string` (ISO 8601) and `device_id: string`. Pre-v1.7 categories lack these fields. Migration happens at load:

- If `data.categories[i].updated_at` is missing, stamp `data.meta.created_at` (or `new Date().toISOString()` if `created_at` is missing).
- If `data.categories[i].device_id` is missing, stamp `data.meta.device_id`.

The backfill is **one-time at load**, not per-edit. Mirror ADR 0009 §6's additive shape but with a real timestamp instead of `null`, so `mergeById`'s `tsOf` returns comparable values from the first merge forward.

**Rejected**: lazy populate at save only. Pre-v1.7 categories with `updated_at` undefined would have `tsOf = 0` and lose to ANY stamped remote, regardless of who actually edited last. This silently rewrites categories the user hasn't edited, which is a regression worse than the bug.

**Rejected**: hard migration with a schema version bump. ADR 0009 §6 explicitly says additive fields don't bump schema. The merge-strategy change is behavioural in `lib/sync.js`, not a schema change. `data.version` stays `'1.1'`.

**Rejected**: backward-populate `updated_at` per-category on every save. Same coverage as load-time backfill but with persistent writes; not needed because load-time backfill already puts the user into a consistent state.

### 3. `deleteCategory` shim pushes a tombstone + keeps the existing confirm dialog

The Alpine shim `deleteCategory(catId)` (in `portfolio.html`) currently does:

```js
this.data.categories = this.data.categories.filter(c => c.id !== catId);
// ...cleanup attributes on holdings/cash/debts...
```

V1.7 adds a tombstone push before the filter:

```js
this.data.deletions.push({
  id: genId('del'),
  target_id: catId,
  type: 'categories',           // ← NEW: 'categories' added to type enum
  deleted_at: new Date().toISOString(),
  device_id: this.data.meta.device_id,
});
this.data.categories = this.data.categories.filter(c => c.id !== catId);
// ...attribute cleanup unchanged...
```

The `confirm('Delete this category? Holdings/cash/debts will lose this attribute.')` dialog stays. The dialog gates the **attribute cascade** (holdings/cash/debts drop the attribute reference), not the tombstone. The two concerns are independent; the dialog is about the user-visible cascade. The tombstone is invisible sync infra.

**Rejected**: drop the confirm dialog. The cascading cost is unchanged and the user has been trained to expect the warning. Removing it is a UX regression.

**Rejected**: drop the attribute cascade. The cascade is the data invariant that "a deleted category's attribute reference is also gone from records". Skipping it leaves orphans.

**Rejected**: replace the tombstone with a separate `data.deleted_categories[]` array. ADR 0011's design was specifically to use one `data.deletions[]` log for all record-bearing collections, keyed by `type`. Adding a parallel log for one collection is a design fragmentation.

### 4. `'categories'` added to the deletion log type enum (ADR 0011 amendment)

ADR 0011 §1 documents the `type` field as keeping the same log for all record-bearing collections, including "any future ones (categories, attribute values, settings)". V1.7 makes this concrete: the `type` field accepts `'categories'` in addition to `'holdings'`, `'cash_accounts'`, `'debts'`, `'snapshots'`, `'plans'`.

The `mergeByIdWithDeletions` helper does not filter by `type` — it filters by `id` matching the merged deletion log. The `type` field is metadata for the user-facing Backups page UI, not for merge logic. Adding `'categories'` is therefore a metadata-only change.

**Rejected**: per-collection tombstones (`deletions_categories[]`). ADR 0011 §"Alternatives considered" rejected this exact pattern for the original log; it would triple (or quadruple) storage and triple the merge rules.

### 5. Settings: object-level newer-wins

Settings merge with a new `mergeSettings(local, remote)` helper:

```js
function mergeSettings(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const lt = Date.parse(local.updated_at || '') || 0;
  const rt = Date.parse(remote.updated_at || '') || 0;
  return rt > lt ? remote : local;  // strict >; tie → local
}
```

The whole settings object is the merge unit. Whichever side has the newer `updated_at` wins; on tie, the local side wins (symmetric with `mergeById`'s tie-break).

**Rejected**: per-field newer-wins. Would require 7 companion `updated_at` fields (one per settings field), 7 merge rules, and 7 stamps in edit handlers. Settings are 7 fields, mostly constants; the precision isn't worth the maintenance.

**Rejected**: keep `replace-from-remote` for settings. Fixes the user-reported category bug but leaves the user one ticket away from the same bug class for settings. Bundling now is the lower total cost.

**Rejected**: per-field merge with deletion-log propagation. Settings have no "delete field" semantic; a tombstone of "fx_rate is gone" is meaningless. Settings as a whole is not record-bearing.

### 6. Settings stamp trigger: edit-path only, not on every `save()`

`settings.updated_at` is bumped **only** at the actual settings edit handlers, not in `save()`:

- `data.settings.fx_rate` change (Alpine `@change` in the header)
- `data.settings.display_currency` toggle (Alpine `setCurrency` or equivalent)
- `data.settings.language` toggle (Alpine `setLanguage`)
- `data.settings.snapshot_cap` lazy-normalize (when the user edits it, e.g. via the menu)

Reason: "user added a holding on Device A" should NOT preempt "Device B's recent fx_rate edit". With `save()`-always-stamps, every save — including holdings/cash/debt/snapshot edits — would bump `settings.updated_at` and make Device A's settings "newer" regardless of whether A actually edited a setting. Edit-path stamps decouple the merge signal from non-settings activity.

**Rejected**: `save()`-always-stamps. Loses the cross-field race semantics the user actually wants ("the device that edited a setting wins, not the device that last saved anything").

**Rejected**: dirty-tracking with a `settingsDirty` flag. Works but adds indirection; the explicit edit-path stamps are searchable in the code (`data.settings.updated_at = ...` is greppable).

### 7. Schema version stays `'1.1'` (no bump)

Both changes are additive at the field level: `categories[].updated_at`, `categories[].device_id`, `settings.updated_at`. The behavioral change (`replace-from-remote` → proper merge) lives in `lib/sync.js`, not in the schema. Per ADR 0009 §6, additive fields don't bump `data.version`. Pre-v1.7 files load into v1.7 cleanly because:

- The load-time backfill stamps `updated_at` + `device_id` on categories and `updated_at` on settings.
- The `mergeByIdWithDeletions` and `mergeSettings` paths are only taken if the field is present; pre-v1.7 data triggers the load-time backfill which makes the field present.
- The deletion log was already additive in v1.1 (ADR 0011); the new `'categories'` `type` value is a metadata extension.

**Rejected**: bump to `'1.7'`. Would falsely signal migration code is needed. The user's data file format is identical; only `lib/sync.js` changes.

### 8. Backward compat during v1.7 rollout: documented known limitation

Pre-v1.7 clients have no tombstone mechanism. If a pre-v1.7 user deletes a category (pure splice), and a v1.7 user merges with them, the v1.7 user sees the category **resurrect** (the v1.3 hard-delete bug class). Same scenario for pre-v1.6 users of `mergeById`-based collections who did hard deletes.

**Mitigation**: documentation only. The same pattern v1.3 used (ADR 0011 §"Rollout"). All users must upgrade to v1.7 for delete propagation to work correctly. The user's data file is unaffected; the issue resolves as soon as all clients are on v1.7.

**Rejected**: load-time lazy-backfill tombstones for missing categories. Would require inferring "this category was deleted because it's not in the merged array" — merges semantics ambiguity (was it deleted, or was it never there?). Not worth the design cost.

**Rejected**: refuse to merge with pre-v1.7 clients. Impractical for a personal-finance tool with multiple devices at different versions.

### 9. Unintended renames on categories: documented known limitation

If both devices edit the same category's name simultaneously, `mergeById` picks the newer `updated_at`. Tie on `updated_at` → local wins (per `mergeById` convention). This is identical to the rename race for holdings/cash/debts/plans, which the user has accepted since v1.3.

**Rejected**: three-way merge with a common ancestor. Requires storing a base version per record, which the schema doesn't track. Out of scope for v1.7.

**Rejected**: prompt the user on rename conflict. Adds UX surface for a rare race condition. Not worth the friction.

## Consequences

### Positive

- The user-reported bug is fixed: categories added on one device survive merge on the other.
- The same fix lands for settings preemptively, avoiding a future bug report.
- The settings fix is small (one helper + 4 edit-path stamps + 1 load-time backfill).
- Categories and settings now follow the same mental model as the rest of the portfolio: per-record (or per-object) `updated_at` + the deletion log for record-bearing collections.
- The deletion log is now genuinely the single source of truth for all record-bearing collections + categories (ADR 0011 §1's "any future ones" promise is fulfilled).

### Negative / known limitations

- **Backward compat during rollout**: until all clients are on v1.7, a delete on a pre-v1.7 client does not propagate to v1.7 clients (the v1.3 hard-delete bug class). Resolves naturally as users upgrade.
- **Unintended renames**: same as for holdings/cash/debts/plans; newer-wins, tie-break local. Documented.
- **Object-level settings merge**: a `display_currency` edit on Device A and a `fx_rate` edit on Device B at the same second will lose one edit (whichever is later). Acceptable because settings are edited rarely and the user rarely edits two settings simultaneously.
- **Load-time backfill writes slightly more bytes**: ~50 bytes per category on first load. Negligible.
- **No schema version bump**: a future maintainer reading `data.version === '1.1'` may assume v1.7 features are absent. Mitigation: ADR 0016 references this decision; the field set is documented in `data-file-format.md`.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Categories mirror plans (per-record + tombstone) | Same pattern as 4 other collections; one mental model; consistent |
| Load-time backfill (not save-time) | One-time write per category on first load; ~50 bytes/category; immediate merge correctness |
| Stay at schema version `'1.1'` | No version bump despite significant behavioural change; relies on ADR + docs |
| Settings object-level (not per-field) | Coarse-grained; cross-field races lose one edit; simple |
| Settings edit-path stamps (not `save()`-always) | 4 edit-handler touchpoints; precise cross-device semantics |
| Keep `deleteCategory` confirm dialog | Same UX as today; dialog is orthogonal to tombstone |
| Document Q5 (rollout) + Q6 (renames) instead of fixing | Same pattern as v1.3 / v1.4 / v1.6; no design fragmentation |

## Alternatives considered

- **Status quo (ADR 0009 §5)** — replace-from-remote for both categories and settings. The user-reported bug is the reason this ADR exists; rejected.
- **Per-field newer-wins for settings** — 7 companion `updated_at` fields, 7 merge rules, 7 stamps. Settings have 7 fields, mostly constants; precision isn't worth the maintenance. Rejected.
- **Per-field merge with deletion log for settings** — settings have no "delete field" semantic; tombstones are for record-bearing collections. Rejected.
- **Lazy populate at save only (no load-time backfill)** — pre-v1.7 categories with `updated_at` undefined would lose to any stamped remote. Silent regression worse than the bug. Rejected.
- **Schema bump to `'1.7'`** — false signal that migration code is needed. ADR 0009 §6 says additive fields don't bump. Rejected.
- **Drop the `deleteCategory` confirm dialog** — dialog gates the attribute cascade, not the tombstone. Two concerns are independent. Removing the dialog is a UX regression. Rejected.
- **Separate `data.deleted_categories[]` log** — ADR 0011 §"Alternatives considered" rejected per-collection logs for the original; same rejection applies. Rejected.
- **Three-way merge for renames** — requires base-version tracking the schema doesn't have. Out of scope. Rejected.
- **Prompt on rename conflict** — UX surface for a rare race. Rejected.

## References

### Internal

- [ADR 0004 — Per-record timestamp merge](0004-per-record-timestamp-merge.md) — `mergeById` is the merge primitive this ADR extends with `mergeByIdWithDeletions` for categories
- [ADR 0009 §5](0009-v1.1-price-tracking.md#5-categories--settings-no-per-field-timestamps) — the v1 limitation this ADR supersedes for categories and settings
- [ADR 0009 §6](0009-v1.1-price-tracking.md#6-additive-fields) — additive fields don't bump schema (basis for staying at `'1.1'`)
- [ADR 0011 — True delete via deletion log](0011-true-delete-deletion-log.md) — `mergeByIdWithDeletions` pattern + deletion log + type enum (amended by this ADR to add `'categories'`)
- [ADR 0013 — Target allocation plans](0013-target-allocation-plans.md) — plans' per-record merge pattern; the most recent sibling precedent
- [ADR 0014 — Snapshot UI](0014-snapshot-ui.md) + [ADR 0015 — Record ordering](0015-record-ordering.md) — ADR section shape precedent
- [`CONTEXT.md`](../../CONTEXT.md) — glossary (target for new `Category merge` + `Settings merge` entries)
- [`lib/sync.js`](../../lib/sync.js) — `mergeByIdWithDeletions` to be reused; new `mergeSettings` helper
- [`lib/records.js`](../../lib/records.js) — `recordDeletion` tombstone pattern (mirror for `deleteCategory`)
- [`portfolio.html`](../../portfolio.html) — `deleteCategory` shim (tombstone push) + 4 settings edit paths (stamp)
- [`data-file-format.md`](../../docs/data-file-format.md) — schema target (lazy-populated `updated_at` + `device_id` per category; `settings.updated_at`)
- [`tests/sync.test.js`](../../tests/sync.test.js) — sync merge tests (extend with category + settings merge scenarios)
- [`tests/browser/`](../../tests/browser/) — browser integration scenarios (T02)

### Wayfinder decisions

This ADR captures grilled decisions Q1–Q9 from `.scratch/v1.7-category-sync/map.md`. Round 1 (Q1–Q4) settled categories. Round 2 (Q7–Q9) settled settings. Q5 + Q6 are documented known limitations. Implementation tickets T01 + T02 are filed at `.scratch/v1.7-category-sync/issues/`.
