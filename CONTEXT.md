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
The currency the user wants *portfolio totals* shown in. Toggles between TWD and USD. Only **position-level aggregates** (market value, gain/loss, cash balance, debt balance, net worth, home group totals) follow the toggle — these are converted from native currencies via FX and rendered in displayCurrency. **Per-share stock facts** (cost/share, price/share, 52w low/high) stay in the record's **native currency** (listing currency), so a USD-listed holding's cost/share shows `$50.00` whether displayCurrency is TWD or USD. The split reflects two questions: "how much USD do I need to buy this?" (native) vs "how does my portfolio roll up in my reporting currency?" (displayCurrency). See ADR 0021 (act vs measure); same rule first documented in ADR 0017 §6 for the Rebalance page.
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

## Rebalance

**Rebalance**:
Read-only advisor that consumes the active plan's *Rebalance-eligible rule*s and produces per-record *Candidate action*s — "buy N shares of X" for holdings, "add $Y to" / "reduce $Y from" for cash accounts. The user picks which candidates to execute; v1.8 has no execute action. Stored recomputation — no per-portfolio state; the active plan + current prices ARE the input. Lives on the new top-level "Rebalance" nav page. See `docs/adr/0017-rebalance-advisor.md`.
_Avoid_: Trading bot, execute trades, broker integration

**Rebalance-eligible rule**:
A `data.plans[].rules[]` entry whose `target_weight_pct` is set to a finite number in `[0, 100]`. Rules without the field remain drift-only rules for the existing Plans feature (per `Plan.validateRule`). One rule is the source of truth for both drift (via `distribute`) and rebalance (via `target_weight_pct`); adding the field is opt-in.
_Avoid_: Active rule, weighted rule, rebalance target

**Candidate action**:
A single (rule, record) row on the Rebalance page showing the per-holding or per-cash-account advice for one rebalance-eligible rule's matched records. Even-split of the rule's *Rebalance target value* across its N matched records per R4-Q1 (each record's `target_value = rule_target_value / N`). All candidates are independent rows; the user picks which to execute. When 2+ rules match the same holding, the page shows N separate rows (one per rule), each in the respective rule's section.
_Avoid_: Trade order, suggestion, recommendation

**Rebalance target value**:
The total value (`rule.target_weight_pct × portfolio.totalValue`, in baseline currency) that one rebalance-eligible rule is aiming to allocate. Even-split across its matched records; candidate rows show `target_value / N` per row. Section summary lines show this in baseline currency; per-candidate-row cells show the record's native currency (per ADR 0017 §6 — "act vs measure"). Holding candidates' `target_shares = target_value_native / current_price`; cash candidates' `target_balance_native = target_value_native`.
_Avoid_: Allocation amount, target dollar amount

**52-week position**:
A holding's current price's place within its 52-week high/low range, computed as `(current_price - low_52w) / (high_52w - low_52w)`. Shown on both the Holdings page (per-row) and Rebalance candidate rows (per-candidate) as the same visual component (`.week52-bar` + `.week52-marker`). Highlighted when current price is in the top decile or bottom decile of the 52-week range. The same `week52Style(record)` helper drives both surfaces.
_Avoid_: 52w range, position in range (less precise), percentile

## Mobile

**Mobile breakpoint**:
The 414 px (iPhone 6 Plus / Max baseline) horizontal floor below which the app switches to the *stacked card layout* and replaces the second-row nav with a *hamburger drawer*. ≥md (768 px / Bootstrap-class tablet) is treated as desktop and renders the existing table layouts. Touch targets are sized for thumb access at this floor (44×44 pt minimum on independent action buttons).
_Avoid_: small screen (vague), responsive (overloaded — describe the shape, not the technique)

**Hamburger drawer**:
The left-side trigger button (`☰` / `✕` glyph) in the header that toggles a right-side slide-in drawer (`w-72`, fixed top-right, `z-50`). Replaces the second-row 8-tab nav at < md so the header's right cluster (currency / language / refresh / sync) plus the drawer still fit within 414 px. Backdrop (`fixed inset-0 bg-black/40 z-40`) clicks close the drawer. Drawer buttons reuse existing navigate handlers plus `mobileNavOpen = false`. See ADR 0020.
_Avoid_: mobile menu (vague), hamburger menu (describes the trigger but not the slide-in behavior)

**Header menu**:
The `⋯` icon button in the header's right cluster that opens a low-frequency settings menu (FX rate inline input, Import JSON, Export JSON). Rendered as a native `<details class="header-menu">` element: the summary is the `⋯` glyph, the body holds the menu items. Native `<details>` semantics handle the open/close toggle on the summary click; Alpine's `@click.outside="$refs.menu.open = false"` closes it on any out-of-menu tap. The `.header-menu` class opts out of the global `summary::before { content: '+' }` rule (added in v1.9 for mobile card `<details>`); without the opt-out, the menu rendered as `+ ⋯` instead of `⋯` at 414 px. The v1.9.1 hamburger race lesson (capture-phase listener racing the opening click) does NOT apply here because there is no backdrop with its own `@click` handler. See ADR 0020 + `.scratch/v1.13-mobile-header-polish/issues/01-mobile-header-polish.md`.
_Avoid_: kebab menu (describes the trigger but not the menu shape), more menu (vague), overflow menu (sounds OS-level)

**Stacked card layout**:
Per-record card rendered instead of a `<table>` row at < md. The card's primary tier (ticker / shares / value / day-delta for Holdings; name + balance for Cash/Debts; value name + drift for Plans drift; ticker + delta + action for Rebalance candidate) is always visible. Secondary fields (cost / price / 52w bar / gain-loss / Active / Edit / Delete / order buttons for Holdings; account_type / interest_rate / last-updated for Cash; etc.) live inside `<details>` and reveal on tap. Implemented via dual markup: desktop `<tr>` wrapped with `hidden md:table`, mobile `<div>` wrapped with `md:hidden`. See ADR 0020.
_Avoid_: card view (overloaded with snapshot cards v1.5), mobile table (describes CSS, not data shape)

**Details expansion**:
HTML `<details>/<summary>` elements used inside every mobile card's secondary tier. CSS gives a custom `+` / `−` marker (browser default is hidden). Zero JavaScript state, native keyboard / screen-reader support, no Alpine binding required. See ADR 0020.
_Avoid_: collapse (overloaded with Alpine `x-collapse`), accordion (implies multi-open behaviour), expandable card

**Touch target**:
The minimum size of an independent action button the user can reliably tap with a thumb. Per Apple HIG and Material Design consensus: ≥44×44 pt on standalone buttons. Inside a `<details>` block, buttons inherit the surrounding card padding for additional hit area so a slightly smaller button remains tappable. Buttons inside table rows on desktop rely on cell padding for effective hit area. See ADR 0020.
_Avoid_: tap target, button size (vague), accessibility target (overloaded with screen-reader concerns)

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
`data.deletions[]` — an additive array of `{id, target_id, type, deleted_at, device_id}` entries that records "this record was hard-deleted; do not resurrect from remote." Combined with `mergeById` to filter out deleted IDs after every merge. Conflict resolution: *delete always wins* — a stale edit on another device after a delete is lost. The log grows unbounded; recovery from a bad delete is via the *Backup* layer, not via deletion-log edits. The `type` field discriminates the record-bearing collections: `'holdings'` / `'cash_accounts'` / `'debts'` / `'plans'` / `'snapshots'` / `'categories'` (added in v1.7 by `docs/adr/0016-categories-and-settings-sync.md`). See `docs/adr/0011-true-delete-deletion-log.md` and `docs/adr/0013-target-allocation-plans.md` §8 for the plans adoption.
_Avoid_: tombstone list (overloaded), delete log (too generic)

**Category merge**:
How `data.categories[]` syncs across devices. Per-record `mergeByIdWithDeletions` (same primitive as *Plan merge* / Holdings / Cash / Debts / Snapshots) using per-category `updated_at` and `device_id`. Both fields are lazy-populated at load time (ADR 0016 §2) so pre-v1.7 files reach merge-eligible state on first sync without a schema version bump. `deleteCategory` pushes a tombstone into the *Deletion log* with `type: 'categories'` so deletes propagate. Replaces the pre-v1.7 `replace-from-remote` workaround (ADR 0009 §5 v1 limitation) — that workaround silently wiped locally-added categories on a stale pull.
_Avoid_: categories sync (generic), category conflict (overloaded)

**Settings merge**:
How `data.settings` syncs across devices. Settings is a singleton object (not record-bearing), so it uses object-level newer-wins on `data.settings.updated_at`: whichever side's timestamp is newer replaces the whole object; tie → local wins (strict `>`). `updated_at` is stamped only at the actual settings edit handlers (`setCurrency` / `setLanguage` / the fx_rate inline input's `@change`) — NOT on every `save()` — so non-settings saves do not preempt the other device's recent settings edit. Backfill at load time if missing (ADR 0016 §2). Coarse-grained: a `display_currency` edit and an `fx_rate` edit at the same second will lose one edit (whichever was earlier); acceptable because settings are edited rarely. Replaces pre-v1.7 `replace-from-remote`.
_Avoid_: settings sync (generic), config merge (overloaded)

**Known limitation**:
A documented upstream or environmental constraint that we cannot fix from our side and that we accept without a workaround in code. The canonical example as of v1.11 is Yahoo Finance IP-level rate-limiting of TWSE-listed bond ETFs (`00687B.TWO` / `00695B.TWO` / `00719B.TWO`) — the Cloudflare Worker proxy sits in front of Yahoo and inherits the 429; per-IP rate limiting on our side (ADR 0019) is independent and downstream of Yahoo's limit, not a contributing cause. The fix would be switching data sources (twse.com.tw / finmind.tw) — a feature, not a bug fix, so it stays out of scope. User-facing workaround: edit the holding → manual price entry via the holding modal's "Current Price / share" field. Each known limitation is filed under `.scratch/v1.11-known-limitations/issues/` with `Status: wontfix`.
_Avoid_: known bug (suggests fix is in flight), known issue (overloaded), edge case (suggests code-level quirk)

## Refresh

**Refresh**:
A user-triggered bulk read of prices (and 52-week high/low + prev close) for one or more holdings from the Yahoo proxy. Driven from the header *Refresh* button (always visible) or the amber *Retry N failed* button (partial-failure recovery). Refresh is treated as an edit for sync purposes: on success, each refreshed holding's `updated_at` is bumped to now and `device_id` is stamped to the current device — so per-record *Newer-wins merge* (ADR 0004) propagates fresher prices from the device that refreshed last, rather than carrying over the stale price the other device still holds. Failed fetches set `_refresh_failed = true` (in-memory only; stripped at `save()`) and leave `updated_at` untouched (portions of the badge stay attached to the next successful refresh or manual edit). Originating trigger is recorded in `device_id` for forensics.
_Avoid_: Manual edit (Refresh is system-triggered, but counts as an edit for merge semantics), Snapshot (Refresh is per-holding and live; Snapshot is whole-portfolio and historical), Backup (Refresh is in-memory state; Backup is rollback snapshot)

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
