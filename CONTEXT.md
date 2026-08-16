# property_tracker

A personal net-worth tracker. **Web companion (v1, current)**. Tracks stocks, cash, and debts, with custom attributes for grouping and manual snapshots for trend analysis.

## Portfolio

**Portfolio**:
The complete collection of assets and liabilities the user tracks.
_Avoid_: Book, ledger, account (all ambiguous)

**Asset**:
Anything owned. In this app, an asset is either a holding (stock) or a cash account.
_Avoid_: Investment (excludes cash), wealth

**Liability**:
Anything owed. In this app, a liability is a debt.
_Avoid_: Debt load (sounds negative)

**Holding**:
A stock position: a ticker plus share count and total cost basis.
_Avoid_: Position (too generic), trade (an event, not a state)

**Cash account**:
A liquid (or near-liquid) bank or investment account: a name plus a balance.
_Avoid_: Account (overloaded), bank account (might be a credit card)

**Debt**:
A liability: a name plus a balance and optional interest rate.
_Avoid_: Loan (excludes credit cards), credit (overloaded)

**Net worth**:
Total assets minus total liabilities, expressed in a chosen currency.
_Avoid_: Wealth, balance (overloaded)

**Ticker**:
A stock symbol, e.g. `2330.TW` or `AAPL`. Used to identify a holding.
_Avoid_: Symbol (overloaded), stock code

**Inactive**:
A state a holding can be in when it has been delisted or otherwise retired. Inactive holdings are not counted in totals but remain in the portfolio for history.
**Do not use as a soft-delete mechanism.** True delete is a separate operation recorded in the *Deletion log* (see `docs/adr/0011-true-delete-deletion-log.md`). The intermediate fix that conflated Delete with Inactive violated this glossary and was superseded; the "Avoid: Deleted" warning above is the correct shape.
_Avoid_: Deleted (sounds destructive), archived (overloaded)

**Manual order**:
A user-defined display sequence of records within a single collection (holdings, cash accounts, or debts). Stored as a `data.<collection>_order[]` array of record IDs; absent means fall back to insertion order. The user edits order via ↑/↓ buttons in the table; the system never auto-sorts. Pure helper `Order.applyOrder` resolves an order array against a record array, defensively dropping stale IDs and appending leftovers. Per-collection (3 arrays: `holdings_order`, `cash_accounts_order`, `debts_order`). Lazy-written: only materialized when the user first reorders. See ADR 0015.
_Avoid_: display order (implies read-only), sort order (sounds automatic), record order (overloaded)

**Order list**:
The `data.<collection>_order[]` array of record IDs that encodes *Manual order*. Per-collection (3 arrays: `holdings_order`, `cash_accounts_order`, `debts_order`). Lazy-written: only materialized when the user first reorders. Sync semantics: prefer-remote (last-synced-wins on offline conflict). See ADR 0015.
_Avoid_: sort key (technical), index list (overloaded), position array (sounds numeric)

## Money

**Native currency**:
The currency a holding, cash account, or debt is denominated in. Set per record, not derived.
_Avoid_: Source currency, original currency

**Display currency**:
The currency the user wants all monetary values shown in. Toggles between TWD and USD. Per-record fields (cost, current price) and aggregates (market value, gain/loss, cash, debts, net worth) both follow the toggle.
_Avoid_: Base currency, report currency

**FX rate**:
The exchange rate used at the moment a snapshot was taken, e.g. `TWD=X` = 32.2. Stored per snapshot.
_Avoid_: Exchange rate, conversion rate

**Compact suffix**:
A display convention for keeping monetary values short. Format is `$<value><suffix>` where the suffix depends on display currency and magnitude:
- TWD: ≥100M → Y (億), ≥10K → W (萬), else full (`$1,265.86`)
- USD: ≥1M → M, ≥1K → K, else full (`$1,265.86`)
All values use `$` prefix regardless of currency; 2 decimals; `-` prefix for negatives.
_Avoid_: Wan (romanisation is not project vocabulary), compact notation (too vague)

## Attribute system

**Attribute**:
A user-defined key-value pair on a holding, cash account, or debt. Used for grouping.
_Avoid_: Tag (overloaded), label (overloaded)

**Category**:
A defined attribute type, e.g. `Sector` or `Market`. Has a name, a list of values, and an `applies_to` set declaring which record types it can be attached to.
_Avoid_: Attribute type, dimension

**Applies-to**:
The record types a category can be attached to. Subset of `{'holdings', 'cash', 'debt'}`. A category with empty `applies_to` is unusable (no record can reference it).
_Avoid_: Scope (technical), target type

**Attribute value**:
A specific value within a category, e.g. `科技` within `Sector`. Each value has a stable ID that records reference.
_Avoid_: Tag value, option

**Grouping**:
Computing aggregate sums (e.g. total value) per attribute value across a set of records.
_Avoid_: Facet, segment

## Navigation (Web)

**Page**:
A top-level navigation destination in the Web app. The user is on one of: Home, Holdings, Cash & Debts, Categories, **Snapshots** (v1.5). State is held in memory; no URL routing.
_Avoid_: View (overloaded with chart views), route (implies URL)

**Home page**:
The default landing page. Shows total net worth (across all record types) and grouping by category. Read-only.
_Avoid_: Dashboard (overloaded), summary page

## Plans

**Plan**:
A user-defined set of target allocations across categories, expressed as flat rules. Multiple plans can exist; one is active at a time. Stored in `data.plans[]`.
_Avoid_: Strategy, allocation (overloaded), target

**Plan rule**:
A single target distribution in a plan. Filters records by category attributes (`when`) and specifies how those records should be distributed across the values of exactly one target category (`distribute`). Independent — a record can fall in multiple rules' actuals; a plan with two independent slices ("TW sleeve" and "stock sleeve") is two rules with the same / overlapping `when` filters and different `distribute` axes. The `name` field is required (per `Plan.validateRule`) and surfaces as the card header on Home's drift report.
_Avoid_: Constraint, condition (overloaded), rule of thumb

**Target distribution**:
A weighted breakdown of records within a single rule's filter, expressed as percentages summing to 100% across the values of one target category. The `distribute` field of a rule.
_Avoid_: Target (overloaded), allocation (overloaded)

**Drift**:
For a single rule, the difference between its target distribution and the actual distribution of matching records' values. Expressed as percentage points per value: `actual_pct - target_pct`. Positive = over-allocated; negative = under-allocated.
_Avoid_: Deviation, variance (technical), gap

**Active plan**:
The plan currently selected for drift computation on Home. Stored as `data.active_plan_id`. Synced across devices via the per-record merge pattern.
_Avoid_: Current plan, selected plan

## Snapshots

**Snapshot**:
A point-in-time record of the user's portfolio, captured manually. Stores the full holdings, cash, and debts at that moment, plus prices and FX rate. One per day, with overwrite confirmation. Read-only history — there is no restore-from-snapshot.
_Critical_: a **Snapshot** is history (manual, selective, read-only, bounded by `Snapshot cap`). A **Backup** is rollback (automatic, full-state, writeable, double-buffered). The two live in different fields (`data.snapshots[]` vs `data.backups[]`) and are governed by different ADRs (0014 vs 0012); do NOT conflate.
_Avoid_: Backup (overloaded — see the snapshot-vs-backup caveat above), checkpoint (technical)

**Snapshot cap**:
The maximum number of snapshots retained per portfolio, stored as `settings.snapshot_cap`. Default `365` (about a year of daily snapshots); user-configurable on the Snapshots page. When a take exceeds the cap, oldest snapshots are dropped (FIFO). The value `0` is the explicit *unlimited* sentinel. A missing / negative / non-number value is lazy-initialised to `365` by `Snapshot.normalizeSnapshotCap` at load time, so v1.0/v1.4 backup files upgrade silently. See ADR 0014.
_Avoid_: retention policy (sounds enterprise), snapshot limit (overloaded with v1.3 deletion limits)

**Snapshot totals**:
The stored aggregate numbers (TWD + USD) for assets, liabilities, and net worth at snapshot time.
_Avoid_: Summary, balance

**Snapshot delta**:
The difference between a snapshot and the previous one, computed at snapshot time. Per-holding and per-total.
_Avoid_: Diff, change (too generic)

**Backup**:
A point-in-time snapshot of the full portfolio used as a recovery target for the *Deletion log*. Two layers, both FIFO 5, both automatic:
- **Layer 1** — stored inside `data.backups[]` as snapshot entries with `{id, saved_at, device_id, data, deletions}`. Captures every `save()`. Syncs across devices via `mergeById` (global 5 newest across all devices).
- **Layer 2** — stored as a Drive file named `portfolio-backup-{device-id}-{ISO-timestamp}.json` in the same folder as `portfolio.json`. Captures every `writePortfolioFile()`. List refreshed on Backups page mount.
Restoring a backup is full-state and self-protected: the current state becomes a new backup before the restore applies, so the user can restore-restore to undo. See `docs/adr/0012-backup-architecture.md`.
_Critical_: a **Backup** is rollback (automatic, full-state, writeable, double-buffered). A **Snapshot** is history (manual, selective, read-only, bounded by *Snapshot cap*). The two live in different fields (`data.backups[]` vs `data.snapshots[]`) and are governed by different ADRs (0012 vs 0014); do NOT conflate.
_Avoid_: snapshot (overloaded — see the backup-vs-snapshot caveat in *Snapshot*), checkpoint (technical), version (overloaded)

## Sync

**Local copy**:
The portfolio JSON held on the user's device.
_Avoid_: Working copy, draft

**Remote copy**:
The portfolio JSON held in Google Drive. The single point of truth across devices.
_Avoid_: Server copy, cloud copy

**Conflict**:
When the local and remote copies have diverged. Resolved per-record using timestamps.
_Avoid_: Merge conflict (technical), edit conflict

**Deletion log**:
`data.deletions[]` — an additive array of `{id, target_id, type, deleted_at, device_id}` entries that records "this record was hard-deleted; do not resurrect from remote." Combined with `mergeById` to filter out deleted IDs after every merge. Conflict resolution: *delete always wins* — a stale edit on another device after a delete is lost. The log grows unbounded; recovery from a bad delete is via the *Backup* layer, not via deletion-log edits. The `type` field discriminates the four record-bearing collections: `'holdings'` / `'cash_accounts'` / `'debts'` / `'plans'`. See `docs/adr/0011-true-delete-deletion-log.md` and `docs/adr/0013-target-allocation-plans.md` §8 for the plans adoption.
_Avoid_: tombstone list (overloaded), delete log (too generic)

## Safety net

**Required check**:
A test that runs on every commit and must pass; failures block commit. In v1.2, `./scripts/safety-net.sh` runs these as a pre-commit gate (unit tests, Worker contract tests, Wrangler dry-run, browser smoke).
_Avoid_: pre-commit hook (suggests git plumbing), CI check (implies external CI)

**Live canary**:
A test that exercises the real Worker + Yahoo endpoints; run on a schedule or before a release; may fail without blocking ordinary development. In v1.2, a separate `./scripts/canary.sh` is planned but not yet built.
_Avoid_: smoke test (overloaded), integration test (overloaded)

**Thin shim**:
An Alpine method whose body is one call into `lib/` plus reactive bookkeeping. The source of truth for tested logic stays in `lib/`; the shim only wires the call.
_Avoid_: wrapper (overloaded), adapter (suggests interface normalisation)

**Safety net**:
The combination of required checks, live canary, and `lib/` extraction that prevents the recent class of regression (script-tag omission, caller-contract mismatch, endpoint drift). Captured in `./scripts/safety-net.sh` and `docs/adr/0010-v1.2-testing-safety-net.md`.
_Avoid_: test suite (too generic), guard (overloaded)
