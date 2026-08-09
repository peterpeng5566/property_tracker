# Portfolio JSON File Format

The wire format for the portfolio. One JSON file, shared between:

- Web localStorage ↔ Google Drive (sync)
- Web export ↔ Web import (replace)

**Source of truth**: `defaultPortfolio()` in [`portfolio.html`](../portfolio.html) (around line 949) and the migration logic in `load()` (around line 1308). Where this doc and code disagree, **code wins**.

## Top-level structure

| Field              | Type     | Notes                                                            |
| ------------------ | -------- | ---------------------------------------------------------------- |
| `version`          | string   | Semver. Current: `'1.1'`. v1.0 files bump to `'1.1'` on load. |
| `meta`             | object   | Identity + sync bookkeeping. Always present.                     |
| `settings`         | object   | User preferences. Always present.                                |
| `categories`       | array    | User-defined attribute categories. Default `[]`.                  |
| `holdings`         | array    | Stock positions. Default `[]`.                                   |
| `cash_accounts`    | array    | Cash / bank accounts. Default `[]`.                              |
| `debts`            | array    | Liabilities. Default `[]`.                                       |
| `snapshots`        | array    | L4 full-detail snapshots. Default `[]`. UI not built in v1 — see [Snapshots](#snapshots). |

## `meta`

| Field            | Type            | Notes                                                                    |
| ---------------- | --------------- | ------------------------------------------------------------------------ |
| `device_id`      | string          | Stable per-device identifier. Format: `web-` + 8-char base36.            |
| `last_synced_at` | string \| null  | ISO 8601 timestamp of last successful Google Drive push/pull. `null` if never synced. |
| `created_at`     | string          | ISO 8601 timestamp. Set once on first `defaultPortfolio()` call.        |

## `settings`

| Field              | Type   | Notes                                                                          |
| ------------------ | ------ | ------------------------------------------------------------------------------ |
| `cost_format`      | string | Always `'per_share'`. `cost` is per-share, not total.                           |
| `display_currency` | string | `'TWD'` or `'USD'`. UI toggle.                                                  |
| `fx_source`        | string | `'manual'` in v1. v1.1+ may add `'yahoo'`.                                     |
| `fx_rate`          | number | TWD per 1 USD. Default `32.2`.                                                 |
| `fx_updated_at`    | string | ISO 8601.                                                                        |
| `language`         | string | `'en'` or `'zh'`.                                                               |

## `categories[]`

Each entry is a user-defined grouping dimension.

| Field        | Type     | Notes                                                                                              |
| ------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `id`         | string   | Stable. Format: `cat-<timestamp>-<4-char base36>`.                                                |
| `name`       | string   | Display name. User-editable.                                                                       |
| `values`     | array    | Each value has `id` and `name`.                                                                   |
| `applies_to` | array    | Subset of `{'holdings', 'cash', 'debt'}`. Empty array means the category is unusable.             |

### `categories[].values[]`

| Field  | Type   | Notes                                                       |
| ------ | ------ | ----------------------------------------------------------- |
| `id`   | string | Stable. Format: `val-<timestamp>-<4-char base36>`.         |
| `name` | string | Display name.                                               |

Renaming a value retroactively affects all records and snapshots that reference it ([ADR 0003](adr/0003-attribute-references-in-snapshots.md)). Deleting a value leaves orphaned IDs in old snapshots — viewers must handle the missing case.

## `holdings[]`

| Field        | Type    | Notes                                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------- |
| `id`         | string  | Stable. Format: `holding-<timestamp>-<4-char base36>`.                       |
| `ticker`     | string  | Yahoo Finance symbol, e.g. `2330.TW`, `AAPL`. See [ADR 0001](adr/0001-yahoo-finance-prices.md). |
| `shares`     | number  | Total share count (fractional allowed).                                       |
| `cost`       | number  | Per-share cost basis. Total cost basis = `shares × cost`.                     |
| `currency`   | string  | Native currency. Default `'TWD'`.                                              |
| `current_price` | number | Cached price. Local cache, 5–15 min TTL. Refreshed on user action. **v1.1: also auto-refreshable via Yahoo batch endpoint.** |
| `high_52w`   | number \| null | 52-week high. `null` until first successful refresh. **v1.1 addition.** |
| `low_52w`    | number \| null | 52-week low. `null` until first successful refresh. **v1.1 addition.** |
| `prev_close` | number \| null | Previous trading day's close. `null` until first successful refresh. **v1.1 addition.** |
| `attributes` | object  | `{ [categoryId]: valueId }`. See [Attributes](#attributes).                   |
| `inactive`   | boolean | `true` for delisted / retired. Inactive holdings are excluded from totals.    |
| `updated_at` | string  | ISO 8601. Set on every edit.                                                  |
| `device_id`  | string  | Device that made the last edit. See [ADR 0004](adr/0004-per-record-timestamp-merge.md). |

### `holdings[]` v1.1 refresh rules

- **`current_price`, `high_52w`, `low_52w`, `prev_close`** are populated together by the bulk refresh button, which calls `/v7/finance/quote?symbols=...` (Yahoo Finance batch endpoint, [ADR 0001](adr/0001-yahoo-finance-prices.md) + v1.1 ADR 0009).
- All four fields are denominated in the holding's native `currency`. Do NOT infer from ticker suffix — read from Yahoo response's `currency` field.
- Field name mapping from Yahoo response:
  - `quote.regularMarketPrice` → `current_price`
  - `quote.fiftyTwoWeekHigh` → `high_52w`
  - `quote.fiftyTwoWeekLow` → `low_52w`
  - `quote.regularMarketPreviousClose` → `prev_close`
- See [ADR 0009](adr/0009-v1.1-price-tracking.md) (forthcoming) for refresh behavior: auto-retry, partial success, manual override, etc.

## `cash_accounts[]`

| Field        | Type    | Notes                                                       |
| ------------ | ------- | ----------------------------------------------------------- |
| `id`         | string  | Stable. Format: `cash-<timestamp>-<4-char base36>`.         |
| `name`       | string  | Display name.                                               |
| `balance`    | number  | Current balance. Sign convention: positive.                 |
| `currency`   | string  | Native currency.                                            |
| `attributes` | object  | `{ [categoryId]: valueId }`.                               |
| `inactive`   | boolean | `true` if the account is closed / retired. Excluded from totals. |
| `updated_at` | string  | ISO 8601.                                                   |
| `device_id`  | string  | Last-editing device.                                        |

## `debts[]`

| Field           | Type    | Notes                                                       |
| --------------- | ------- | ----------------------------------------------------------- |
| `id`            | string  | Stable. Format: `debt-<timestamp>-<4-char base36>`.         |
| `name`          | string  | Display name.                                               |
| `balance`       | number  | Current outstanding balance. Sign convention: positive.      |
| `currency`      | string  | Native currency.                                            |
| `interest_rate` | number \| null | Annual rate as decimal (e.g. `0.035` = 3.5%). `null` if unknown. |
| `attributes`    | object  | `{ [categoryId]: valueId }`.                               |
| `inactive`      | boolean | `true` if the debt is paid off / closed. Excluded from totals. |
| `updated_at`    | string  | ISO 8601.                                                   |
| `device_id`     | string  | Last-editing device.                                        |

## Attributes

`attributes` is an **object map of category-id → value-id**, not an array of strings. Each key is a category's stable `id`, and each value is one of that category's stable value `id`s.

Records reference values by stable ID, so renaming a value doesn't lose data ([ADR 0003](adr/0003-attribute-references-in-snapshots.md)). The semantics are equivalent to a typed key–value bag. A record holding an attribute ID whose category (or value) has been deleted is an **orphan** — see [Rules](#rules).

## Rules

- **All records have a stable `id`** generated as `<prefix>-<ms-timestamp>-<4-char base36>`. Never re-generated.
- **Records updated post-v1 carry `updated_at` + `device_id`** on every record type except categories (which are metadata, not per-record). These are required for the per-record merge in [ADR 0004](adr/0004-per-record-timestamp-merge.md).
- **Missing fields default to `defaultPortfolio()` values.** Both `load()` and the import path shallow-merge with the defaults before saving, so a partial file is accepted.
- **IDs are referenced by string equality only.** No foreign-key integrity is enforced; if a referenced `categoryId` or `valueId` is deleted, the reference becomes orphaned and the viewer should fall back to displaying the raw ID or `(deleted)`.

## Migration rules

### v0.4 → v1.0

The migration is run on every `load()` and on Import. Steps, in order:

1. **Cost format**: if `settings.cost_format !== 'per_share'`, for each holding with `shares > 0 && cost`, replace `cost ← cost / shares`. Then force `settings.cost_format = 'per_share'`.
2. **Top-level arrays**: if `cash_accounts` is missing, set `[]`. Same for `debts`.
3. **Per-record `attributes`**: for each holding / cash account / debt, if `attributes` is missing, set `{}`.
4. **Categories `applies_to`**: for each category, if `applies_to` is missing, set `['holdings']` (the most common intent at v0.4; only holdings used the attribute system). A category with empty `applies_to` after migration is flagged as unusable.

Field-level migrations (e.g. `cost` total → per-share) are destructive of the original value — the migration is one-way. Users upgrading from v0.4 lose the total cost, but `shares × cost` (per-share) gives the same total.

### v1.0 → v1.1

**Non-destructive.** v1.1 adds `high_52w`, `low_52w`, `prev_close` to each holding. The migration is run on every `load()` and on Import. Steps, in order:

1. **Holding field additions**: for each holding, if `high_52w`, `low_52w`, or `prev_close` is missing, set to `null`. (Yahoo batch refresh will populate on next user action.)
2. **Version bump**: set `version: '1.1'` immediately after the field additions — on load, before any save. See the v1.1 schema section in [`.scratch/price-tracking/schema-section.md`](../.scratch/price-tracking/schema-section.md) for rationale.

Unlike v0.4 → v1.0, this migration does NOT touch existing values. No user confirmation is required. The new fields are simply absent (JSON `null`) until a refresh populates them; the UI shows `—` as a hint.

**Backward compatibility**: a v1.0 app loading a v1.1 file ignores the extra fields. Edits in v1.0 will silently drop `high_52w` / `low_52w` / `prev_close` on save — round-trip loss. Both devices must be on v1.1 to fully preserve the new fields via sync.

## Snapshots

**Snapshot UI is a separate v1.1 effort** (not the price-tracking effort). The `snapshots` field is reserved but the UI to populate it is not built in v1. Currently always `[]`.

**Current schema (per v1.1 price tracking spec)**: only `current_price` per holding. 52W high/low and prev_close are NOT included in snapshots — see [ADR 0009 §7](adr/0009-v1.1-price-tracking.md#7-snapshot-schema-unchanged) and the full v1.1 spec at [`.scratch/price-tracking/spec.md`](../.scratch/price-tracking/spec.md).

The intended shape for the (separate) snapshot UI effort is L4 full-detail per [ADR 0005](adr/0005-l4-snapshot-storage.md) and references attributes by ID per [ADR 0003](adr/0003-attribute-references-in-snapshots.md). The snapshot UI effort may add fields beyond `current_price`; `snapshots: []` is the only valid v1.0/v1.1 price-tracking state.

## Storage

- **v1 Web**: single localStorage key `property_tracker_portfolio_v1` ([ADR 0007](adr/0007-v1-web-storage-localstorage.md)). Pretty-printed (2-space indent) for debuggability.
- **Sync**: same JSON written to / read from Google Drive as the single source of truth ([ADR 0002](adr/0002-google-drive-sync.md)). Drive is not versioned — the user's most recent push wins on conflict.
