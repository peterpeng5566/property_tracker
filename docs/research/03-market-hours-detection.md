# Research 03: Market hours detection for intraday warning

**Question**: How should the app determine if a market is currently open (intraday) when the user clicks "Snapshot"?

**Verdict**: Use `result[i].marketState` from the `/v7/finance/quote` response (already in the bulk-refresh payload, zero extra HTTP calls). State enum is explicit; no computation needed.

## Primary approach: read `marketState` from Yahoo

Yahoo's `/v7/finance/quote` response includes a `marketState` field per symbol. Full enum (verified by user across 19 archived responses):

| State | Meaning | Warn user? |
|-------|---------|------------|
| `PREPRE` | Pre-pre-market (some exchanges) | Yes |
| `PRE` | Pre-market | Yes |
| `REGULAR` | Regular trading session | Yes |
| `POST` | Post-market | Yes |
| `POSTPOST` | Extended post-market | Yes |
| `CLOSED` | Market closed (overnight / weekend / holiday) | No |
| *(missing)* | Defensive default | Yes |

Per-aggregate rule: show the warning **once** if ANY holding's market is currently active.

## Algorithm

```js
const INTRADAY_STATES = new Set(['PREPRE', 'PRE', 'REGULAR', 'POST', 'POSTPOST']);

function shouldWarnIntraday(quoteResponses, holdings) {
  for (const h of holdings) {
    if (h.currency === 'FX') continue;  // explicit FX exception
    const meta = quoteResponses[h.ticker];
    if (!meta) continue;  // missing = no signal, treat as "no warning" (failed holding covered by retry UX)
    if (INTRADAY_STATES.has(meta.marketState)) return true;
  }
  return false;
}
```

Defensive default when `marketState` is missing: do NOT warn (assume closed). The "treat missing as intraday" alternative was considered but rejected — missing data means Yahoo didn't return, which is the same case as "failed", and the auto-retry UX already covers it. Two layers of "intraday" warnings would be noisy.

## FX (`quoteType === 'CURRENCY'`) exception

Yahoo reports `marketState: REGULAR` for `TWD=X` even on Saturday / Sunday (FX trades 24/5). Suppress the warning entirely for currency tickers — FX snapshots don't have a meaningful "intraday" concept.

## Holiday handling (verified)

Yahoo returns `marketState: CLOSED` on US market holidays:

- MLK Day 2022 — `CLOSED` ✓
- Thanksgiving 2022 — `CLOSED` ✓
- Presidents Day 2023 — `CLOSED` ✓

No separate holiday calendar needed. Yahoo handles it.

## Fallback evaluation (rejected)

**`nager.date`** — public holiday API. Evaluated and rejected:
- TW data: returns HTTP 204 (no content)
- US list: includes Good Friday which is NOT a NYSE holiday (markets are open that day)
- Adds an extra HTTP call per refresh
- Yahoo already covers it

**Hardcoded hours per exchange** — also rejected:
- TWSE: 09:00–13:30 Mon–Fri (4.5 hours)
- NYSE/Nasdaq: 09:30–16:00 ET Mon–Fri (6.5 hours)
- Requires maintaining per-exchange tables, doesn't handle DST correctly without separate timezone math, fails on holidays

**Yahoo `currentTradingPeriod` (no-auth alternative)** — works but more code:
- Compare `currentTradingPeriod.regular.start/end` against `Date.now()/1000`
- Compute pre/post session boundaries manually
- Edge case: pre/post start/end can have equal values for some exchanges (FX), needs special-casing

→ Less explicit than `marketState` enum. Use only if we drop `/v7/finance/quote` for `/v7/finance/spark` (no-auth).

## Outstanding manual QA

- Verify `2330.TW` returns `marketState: CLOSED` on a TW market holiday (Dragon Boat Festival, National Day, etc.) before shipping
- Edge case: holding with no live quote (Yahoo silently dropped) — does the warning fire? Per algorithm above: no warning. Acceptable because the failed holding's red badge covers it.

## Sources

- User's archived research: 19 primary Yahoo responses, multiple dates, verified holiday behavior on US markets
- Our direct curl tests on `/v7/finance/spark` (which lacks marketState — supports the user's choice of `/v7/finance/quote`)
- ADR 0001 in this repo

## Implications for spec tickets

- **#04 Full spec** (snapshot section): intraday warning uses `marketState` enum from quote response
- **#05 ADR 0009**: cite `marketState` as the data source, document the per-aggregate rule
- **#01 Schema spec**: no schema change — `marketState` is computed at refresh time, not stored on holding