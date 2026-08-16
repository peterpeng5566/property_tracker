# 0015 — Manual record ordering (v1.6)

## Status

Accepted (v1.6)

## Context

After v1.4 (Plans) and v1.5 (Snapshot UI), the user can curate categories, set target allocations, and capture snapshot history of their holdings, cash, and debts — but the *display order* of the holdings / cash / debts tables is hard-locked to *insertion order*. Two users on the same portfolio want different display orders (largest holdings first vs. watchlist-first vs. recent-edits-first); today neither can reorder their own view without re-adding records.

The architectural questions this ADR answers are *how* the user-explicit reorder is wired, not *what* an order array is (it's just an ID list). The order array itself is a UX preference, not data correctness — snapshot totals (ADR 0005), backup state (ADR 0012), and the per-record merge (ADR 0004) are all orthogonal to display order. The user-facing spec is the four tickets (`01–04`) under `.scratch/v1.6-record-ordering/`. This ADR captures the load-bearing decisions those tickets made and that future change should treat as locked.

## Decision

### 1. Manual-only; no auto-sort

**The user reorders records via ↑/↓ buttons on each row in the Holdings / Cash & Debts tables. There is no auto-sort by ticker, value, last-modified, or anything else.** No drag-and-drop, no "sort by" dropdown, no keyboard shortcut for "move to top." The user's explicit clicks are the only thing that writes the order array.

**Rejected**: auto-sort-by-value, drag-and-drop, sort-by-column headers. Reasons:
- Auto-sort is the kind of "the app is doing something I didn't ask for" surprise that ADR 0014 §1 calls out for snapshots — the same precedent applies to display order. The user owns the order; the app respects it.
- Drag-and-drop is a bigger UX commitment (touch handling, accessibility, animation budgets) than ↑/↓ buttons. ↑/↓ are keyboard-friendly, screen-reader-friendly, and trivial to test with Playwright. We can add drag-and-drop later if the user complains.
- Sort-by-column-headers change the *stored* order, which is a UX preference that should be the user's choice — not something the table decides for them.

### 2. Per-collection ID array; not inline `position: number`

**Each collection (holdings / cash_accounts / debts) maintains its own `data.<collection>_order[]` array of record IDs.** `holdings_order` lives at the top level of the portfolio JSON, alongside `holdings`, `cash_accounts`, `debts`, `snapshots`, `plans`, `deletions`. The template iterates `Order.applyOrder(records, orderArray)` rather than the raw `data.holdings` array.

**Rejected**: inline `position: number` field on each record. Reasons:
- Mirrors the existing `data.snapshots[]` / `data.deletions[]` / `data.plans[]` separation-of-metadata-from-records pattern. The records array carries *data*; the order array carries *display preference*. Keeping them separate means the merge logic (ADR 0004) doesn't need to change at all when records update.
- A `position: number` field forces every insert + delete to renumber its siblings (or accept gaps), which is a sync disaster: two devices that each add a record simultaneously produce two `position: 4` values that have to be resolved out of band. ID lists sidestep this — an `appendToOrder` from either device is a single insert at the end, and the prefer-remote merge (§4) handles the conflict silently.
- The "order array" reads more naturally than `position`. A reader sees `holdings_order: ['h-2', 'h-1', 'h-3']` and immediately knows what it means; a reader sees `holdings[].position: [2, 1, 3]` and has to look up the convention.

### 3. Lazy-write semantics: array absent until first reordering

**`data.<collection>_order` is absent from the JSON until the user first reorders records in that collection.** A portfolio that has never been reordered never has any `*_order` array in its JSON (and never writes one). The first ↑/↓ click materializes the array from the current insertion order, then applies the swap.

`Order.applyOrder(records, ids)` is the defensive loader: if `ids` is missing/non-array, it returns a shallow clone of `records` in insertion order. This means *every code path that reads the order array* (the template, the row buttons, the helper) handles the missing case transparently — no special "has the user reordered yet?" branching.

**Rejected**: assert `*_order` exists on every load. Reasons:
- Pre-v1.6 backups (the entire installed base at the time of this ADR) have no `*_order` arrays. Asserting presence would either reject existing backups (breaking the upgrade) or require a one-time migration that adds empty arrays (which the smoke test in T04 confirms is not needed).
- A user who never reorders shouldn't pay the cost of a `*_order` array in every backup. Lazy-write keeps the pre-v1.6 wire format unchanged for the common case.
- The defensive `applyOrder` contract means every read site is correct against both "absent" and "explicit". The "has the user reordered?" question is implicitly answered by `Array.isArray(...order)`.

### 4. Sync semantics: prefer-remote (last-synced-wins)

**`Sync.mergePortfolios` treats each `*_order` array as a scalar pointer with the same "prefer-remote, fall back to local" merge as `active_plan_id` / `settings` (per ADR 0009 §5).** When two devices reorder offline and then sync, the earlier edit is silently overwritten by the later one. There is no per-position LWW merge, no event log, no conflict-resolution UI.

```
holdings_order: remote.holdings_order !== undefined
  ? remote.holdings_order
  : (local.holdings_order !== undefined ? local.holdings_order : undefined)
```

**Rejected**: per-position LWW merge, event log of reorders, conflict-resolution UI. Reasons:
- Display order is a UX preference; the cost of a wrong merge is "the table looks the way I set it on my other device" — not data loss, not a value error, not a constraint violation. The cost of per-position LWW is a 3-4× more complex merge (timestamp on each slot, handle simultaneous appends, etc.) for a use case the user will never notice.
- ADR 0009 §5 established prefer-remote for `active_plan_id` and `settings` because those are also scalar UX preferences. Mirroring the pattern keeps the merge logic small and consistent.
- The user's typical edit cadence is "reorder once, then forget" — the rate of *simultaneous reordering on two devices* is essentially zero. The conflict-resolution surface would be unreachable code.

**Documented limitation**: when both devices reorder offline and then sync, the earlier edit is silently overwritten. This is acceptable for a UX preference; the user can re-reorder on the losing device if they care.

### 5. UI scope: Holdings + Cash + Debts only

**The Order column ships on the three record-bearing tables (Holdings, Cash, Debts). The Categories page and the Plans page are explicitly out of scope.** No reorder UI on the Categories page (where the row unit is a category, not a record) and no reorder UI on the Plans page (which has an active-pointer, ADR 0013, that competes with manual order).

**Rejected**: include Categories / Plans reorder. Reasons:
- Categories are metadata, not records. Reordering them has weak UX value (the values are the editing unit). Defer until user complaint.
- Plans already have an active-pointer; the "active" badge is position-independent. Adding manual order on the Plans page would create a UX conflict: "is this one active because I made it active, or because I dragged it to the top?" Defer until user complaint.
- Scope discipline per ADR 0014: the snapshot engine itself is a single ADR with N UI tickets; the same shape applies here. We can add a Categories / Plans reorder ADR later if the user actually wants it.

### 6. ↑/↓ button affordance; ARIA-correct disabled states

**Each row gets two buttons: ↑ (move up) and ↓ (move down). Both are pure HTML `<button>` with `:disabled` bound to the boundary check.** Disabled states are ARIA-correct:
- Top row (idx === 0): ↑ disabled, ↓ enabled.
- Bottom row (idx === length - 1): ↑ enabled, ↓ disabled.
- Single row (length === 1): both disabled.

The button title attribute is "Move up" / "Move down" when enabled, "Already at the top" / "Already at the bottom" when disabled — the screen reader announces the disabled state through the title.

**Rejected**: drag handles (≡), single "move" button with a dropdown, inline `position: number` input. Reasons:
- ↑/↓ buttons are keyboard-friendly (Tab + Enter), screen-reader-friendly (button role + title), and visually trivial (no extra iconography). They match the principle of least surprise for a reorder UI.
- Drag handles are a bigger UX commitment (touch handling, accessibility, animation budgets) than the user's likely reorder usage justifies. We can add drag-and-drop later if the user complains.
- A single "move" button with a dropdown is two clicks where ↑/↓ is one. The user wants to reorder, not to navigate a picker.

### 7. Inactive rows stay in user position

**Toggling `inactive: true` on a reordered row does NOT move the row.** Manual order is sacred; `toggleInactive` only changes the visual style (opacity-50) and excludes the row from totals. The order array references the record ID, not the active flag — the row keeps its slot whether active or inactive.

**Rejected**: move inactive rows to the bottom (auto-sort by inactive flag). Reasons:
- The user reordered; we should not silently re-sort.
- An inactive row that comes back to active (the user re-lists the ticker) should restore to its user-explicit position, not to a "newly-added" position.
- The opacity-50 styling provides the visual signal of "inactive" without changing position.

### 8. Snapshot capture-time freeze (orthogonal to live order)

**`lib/snapshot.js` `buildSnapshot` deep-copies the live `cleaned.holdings` / `cleaned.cash_accounts` / `cleaned.debts` arrays as-is.** The capture-time order of those arrays is whatever insertion order they had at snapshot time. After the snapshot is taken, the user can reorder the live portfolio freely; the historical snapshot is unaffected.

The snapshot *does not* carry the `*_order` arrays — those are live-portfolio UX preferences, not portfolio state. The snapshot's `holdings` array is the record-of-truth at capture time, in capture order. (If the user wants to inspect "how did I have my holdings ordered at snapshot N?", they can re-read the snapshot's `holdings` array directly; the order array is the live-portfolio view layer only.)

**Rejected**: store order arrays inside snapshots. Reasons:
- A snapshot is a frozen historical view. The order is a UX preference of the live portfolio.
- Snapshot storage is bounded by `settings.snapshot_cap` (default 365); the order array would count against that cap for a UX preference that doesn't change historical interpretation.
- The snapshot's `holdings` array is already in some order (capture-time insertion order); the user can re-sort on the snapshot detail view if they want, but the order array is not part of the snapshot's contract.

### 9. Mechanical: add appends, delete removes, defensive filter

**The user's mechanical CRUD operations interact with the order array as follows:**
- **Add a record** — the `saveHolding` / `saveCash` / `saveDebt` shim calls `Order.appendToOrder` only if the array already exists. **If the array is absent, it stays absent (lazy-write preserved).** This is the one deviation from the natural "add a record → put it at the end of the order array" behavior: pre-v1.6-style portfolios that the user adds records to (without ever reordering) never get an order array.
- **Delete a record** — the `_removeRecord` shim calls `Order.removeFromOrder` to strip the id from the matching order array. If the array is absent, no-op.
- **Reorder (↑/↓)** — the `_moveOrderItem` helper resolves the index in the *ordered* view (not the raw records array), applies the swap via `Order.moveItem`, and writes the new array back to `data.<collection>_order`. If the array is absent, materialize from insertion order first.
- **Reconcile against records** — `Order.applyOrder` defensively: filters stale IDs (record was deleted), appends records whose id never appeared in the order array (handles records added after the array was materialized), and skips non-string IDs. The reconciliation happens at every render via the getter, so the table always shows the right order even if the order array is stale relative to the records.

**Rejected**: "add puts the new record at the top" (violates lazy-write — every portfolio with new records would have an order array), "add puts at insertion position" (requires a position field, rejected by §2), "delete does not touch the order array" (leaves stale ids that confuse the helper).

## Test count snapshot

At v1.6 close-out (commits 183d92c + 7c59437 + 5f3898d + this ADR's commit):

- `tests/order.test.js` — **32 unit tests** for `applyOrder` / `moveItem` / `appendToOrder` / `removeFromOrder` (defensive inputs, idempotency, immutability, stale-id filtering, leftover-append, boundary guards).
- `tests/sync.test.js` — **6 new merge tests** for `holdings_order` / `cash_accounts_order` / `debts_order` (prefer-remote, fallback-to-local, undefined-when-both-missing, empty-array preserved, cross-collection independence).
- `tests/browser/ordering.spec.js` — **19 browser scenarios** (4 mechanical T01 + 6 holdings-UI T02 + 7 cash+debts-UI T03 + 2 integration T04). Integration coverage: multi-device sync prefer-remote wins, v1.5 backup compatibility lazy-write.

v1.6 added: **38 unit tests + 19 browser tests** across 3 files. All green via `./scripts/safety-net.sh` (4 stages: unit, Worker contract, Wrangler dry-run, browser smoke).

## Consequences

### Positive

- The user can reorder their holdings, cash accounts, and debts in any order they prefer, with the change persisting on-device and syncing across devices.
- The lazy-write contract means pre-v1.6 backups are forward-compatible without any migration code.
- The `*_order` arrays are additive fields — no schema version bump, no version-branching in the merge logic.
- The UI is a thin shim over `lib/order.js` (the 4 pure exports); all reorder logic is unit-tested in `tests/order.test.js`.
- Future drag-and-drop or auto-sort features can be added on top of the same `Order.moveItem` / `Order.applyOrder` primitives without changing the storage shape.

### Negative / known limitations

- **No multi-device conflict resolution.** If two devices reorder offline, the later push wins silently. Acceptable per §4.
- **No drag-and-drop.** The user clicks ↑/↓ buttons. Revisit if user complaints.
- **Categories page / Plans page** are explicitly out of scope. Reorder on those pages is a future ADR.
- **Snapshot's holdings order is capture-time insertion order**, not the user's live order at snapshot time. If the user wants "snapshot as of date X, displayed in my current order", they have to manually re-sort on the snapshot detail view (out of scope — the snapshot detail view is read-only).
- **4 browser scenarios for the cross-collection lazy-write + delete + reload** are covered by T01 — but the *combination* of all three behaviors in the same portfolio is not yet tested. If users report surprising interaction, add a T05 integration scenario.

## Alternatives considered

- **Auto-sort by value, ticker, or last-modified.** Rejected per §1 — user-explicit only.
- **Drag-and-drop affordance.** Rejected per §1 — ↑/↓ suffice; revisit if user complaints.
- **Inline `position: number` field.** Rejected per §2 — sync-friction + pattern-break.
- **Categories / Plans reorder.** Rejected per §5 — scope creep without user-value justification.
- **Per-position LWW merge (event log of reorders).** Rejected per §4 — UX preference doesn't justify the merge complexity.
- **Reorder within a snapshot.** Rejected per §8 — snapshot is a frozen historical view.
- **Schema version bump to `'1.6'` for the order arrays.** Rejected per ADR 0009 §6 — additive fields don't bump schema.
- **`t('holdings.col.order')` key reversed to `t('ordering.col.order')` shared across tables.** Considered and rejected — each table has its own column header context (the order is local to the table), and the existing precedent (per-table `col.sort` / `col.name` / `col.balance` keys) is per-table.

## References

- `.scratch/v1.6-record-ordering/` — ticket breakdown
- ADR 0003 — attribute references in snapshots (orthogonal; reorder doesn't touch attributes)
- ADR 0004 — per-record timestamp merge (orthogonal; the order arrays use *coarse-grained* prefer-remote, not per-record merge)
- ADR 0005 — L4 snapshot storage (snapshot capture-time freeze, §8)
- ADR 0009 §5 — `active_plan_id` / `settings` prefer-remote pattern (template for §4)
- ADR 0009 §6 — additive fields don't bump schema (lazy-write + schema stays `'1.1'`)
- ADR 0011 — deletion log (order arrays interact with tombstone filter via `applyOrder`'s stale-id drop)
- ADR 0013 — target-allocation plans (plan reorder explicitly out of scope, §5)
- ADR 0014 — snapshot UI (precedent for ADR section shape, "manual-only" precedent for §1)
- `CONTEXT.md` — glossary entries for *Manual order*, *Order list*
- `lib/order.js` — pure helpers (4 exports: `applyOrder`, `moveItem`, `appendToOrder`, `removeFromOrder`)
- `lib/sync.js` — `mergePortfolios` 3 prefer-remote lines for `holdings_order` / `cash_accounts_order` / `debts_order`
- `tests/order.test.js` — 32 unit tests
- `tests/sync.test.js` — 6 merge tests
- `tests/browser/ordering.spec.js` — 19 browser scenarios
