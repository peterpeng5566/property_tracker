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
_Avoid_: Deleted (sounds destructive), archived (overloaded)

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
A top-level navigation destination in the Web app. The user is on one of: Home, Holdings, Cash & Debts, Categories. State is held in memory; no URL routing.
_Avoid_: View (overloaded with chart views), route (implies URL)

**Home page**:
The default landing page. Shows total net worth (across all record types) and grouping by category. Read-only.
_Avoid_: Dashboard (overloaded), summary page

## Snapshots

**Snapshot**:
A point-in-time record of the user's portfolio, captured manually. Stores the full holdings, cash, and debts at that moment, plus prices and FX rate. One per day, with overwrite confirmation.
_Avoid_: Backup (overloaded), checkpoint (technical)

**Snapshot totals**:
The stored aggregate numbers (TWD + USD) for assets, liabilities, and net worth at snapshot time.
_Avoid_: Summary, balance

**Snapshot delta**:
The difference between a snapshot and the previous one, computed at snapshot time. Per-holding and per-total.
_Avoid_: Diff, change (too generic)

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
