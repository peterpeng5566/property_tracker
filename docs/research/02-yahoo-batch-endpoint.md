# Research 02: Yahoo Finance batch endpoint

**Question**: Does Yahoo Finance offer a single API call that returns `current_price`, `52-week high`, `52-week low`, and `previous close` for **multiple symbols at once**?

**Verdict**: YES — recommended endpoint is `/v7/finance/quote?symbols=A,B,C` (with crumb auth, per user research). A no-auth alternative `/v7/finance/spark` also works for the 4 fields but lacks `marketState`.

## Primary recommendation: `/v7/finance/quote` (with crumb auth)

Per user's deeper research (19 archived responses across multiple dates, holiday verification, edge-case enumeration):

```
GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,2330.TW,TWD=X&crumb=<CRUMB>
```

### Auth flow (since late 2024)

Yahoo's `/v7/finance/quote` requires a `crumb` token. Bootstrap once at app startup:

1. Fetch Yahoo consent cookie from `https://fc.yahoo.com/`
2. Get crumb token from `https://query1.finance.yahoo.com/v1/test/getcrumb` (uses the cookie)
3. Append `&crumb=<CRUMB>` to every quote call
4. On HTTP 401: re-bootstrap and retry once

Cloud IPs (e.g. CI runners) get aggressive 429 rate-limiting; personal browser is fine.

### Response fields (verified by user)

```
regularMarketPrice       ← current_price
regularMarketPreviousClose ← prev_close (note: "PreviousClose" suffix, not "chartPreviousClose")
fiftyTwoWeekHigh         ← high_52w
fiftyTwoWeekLow          ← low_52w
marketState              ← "PREPRE" / "PRE" / "REGULAR" / "POST" / "POSTPOST" / "CLOSED"
currency                 ← per-symbol currency
```

Mapping to our schema fields:

```
quote.regularMarketPrice        → holding.current_price
quote.regularMarketPreviousClose → holding.prev_close
quote.fiftyTwoWeekHigh          → holding.high_52w
quote.fiftyTwoWeekLow           → holding.low_52w
quote.marketState               → used by #03 (market hours detection)
quote.currency                  → override holding.currency (in case ticker was renamed)
```

## Alternative (verified by us): `/v7/finance/spark` (no auth)

```
GET https://query1.finance.yahoo.com/v7/finance/spark?symbols=AAPL,2330.TW,TWD=X&range=1d&interval=1d
```

- No crumb needed (works with browser User-Agent header)
- Returns `regularMarketPrice`, `fiftyTwoWeekHigh`, `fiftyTwoWeekLow`, `chartPreviousClose`
- `marketState` is **not present** (returns `None`); market hours must be derived from `currentTradingPeriod`
- Field name for previous close differs: `chartPreviousClose` (not `regularMarketPreviousClose`)
- All 4 spec fields present, both US and TW tickers work, mixed batch up to 5 symbols tested

### Why we don't recommend spark

Loses `marketState` field. To detect market hours, must compute from `currentTradingPeriod.regular.start/end` against `Date.now()/1000`. Adds an extra step per holding and edge-case logic (pre/post market handling, holiday detection). Quote's `marketState` is a single string field with explicit semantics — cleaner.

## Endpoints tested (full matrix)

| Endpoint | Result | Notes |
|----------|--------|-------|
| `/v6/finance/quote?symbols=...` | 404 | Deprecated |
| `/v7/finance/quote?symbols=...` | 401 without crumb, 200 with crumb | **Recommended** |
| `/v7/finance/spark?symbols=...` | 200 without auth | Alternative, no marketState |
| `/v8/finance/chart/{symbol}` | 200 | Single-symbol only — would need N calls |
| `/v8/finance/chart/{symbols}` (multi) | 404 | Doesn't support multi-symbol |

## Error behavior (spark tested directly; quote behavior inferred)

For `/v7/finance/spark` (verified via live curl):

| Scenario | Behavior |
|----------|----------|
| All valid | All returned |
| 1 invalid + N valid | Invalid silently dropped; valid returned |
| 1 delisted + 1 valid | Delisted silently dropped |
| All invalid | Top-level `error: "Not Found"`, `result: null` |
| Empty symbols param | Bad Request |

**Implication for spec**: "Failed holding" = symbol requested but not in response. App compares requested list to returned list; missing = treat as failed. Per-symbol 401/429 retry per the spec's auto-retry strategy.

For `/v7/finance/quote`: same behavior expected (Yahoo's quote endpoint follows the same silent-drop pattern, per community documentation).

## Rate limits

- Spark: 100 sequential requests all returned 200; 30 parallel all returned 200. No rate limit observed for personal use.
- Quote + crumb: same — personal browser is fine. Cloud IPs hit 429; the spec's auto-retry 5x handles this.

## Currency handling

Both endpoints return `currency` per symbol. Don't infer from ticker suffix — read from response. Protects against ticker-renamed cases (e.g. a stock migrating from TWD to USD listing).

## Sources

- User's archived research: 19 primary responses, multiple dates, verified holiday behavior (MLK 2022, Thanksgiving 2022, Presidents Day 2023)
- Our direct curl tests on `/v7/finance/spark` (2026-08-09), recorded in this session
- ADR 0001 in this repo (`docs/adr/0001-yahoo-finance-prices.md`) — original chart endpoint choice
- nager.date evaluated as holiday-API fallback and rejected: returns HTTP 204 for TW; US list includes Good Friday which is NOT a NYSE holiday

## Implications for spec tickets

- **#01 Schema spec**: field names map cleanly to either endpoint; spec should note which endpoint is canonical
- **#04 Full spec**:
  - Document the crumb bootstrap in the auth section
  - Specify "failed" = missing-from-response semantics
  - Reference `/v7/finance/quote` as the canonical endpoint
- **#05 ADR 0009**: cite `/v7/finance/quote` (with crumb flow) as the v1.1 batch source
- **#06 Update ADR 0001**: extend to cover quote (with crumb) AND spark (as no-auth alternative)

## Outstanding manual QA

- Verify `2330.TW` returns `marketState: "CLOSED"` on a TW market holiday (e.g. Dragon Boat Festival, National Day) before shipping
- Verify crumb refresh cadence — does Yahoo expire the crumb mid-session, or only on cookie clear?
---

## ⚠️ DEPRECATED (2025)

This endpoint is no longer accessible from Cloudflare Workers. Yahoo locked
`/v7/finance/quote` (and its sibling crumb endpoint `/v1/test/getcrumb`)
behind browser-session-derived crumb auth in 2025. See
[research/05-chart-endpoint.md](05-chart-endpoint.md) for the replacement
(`/v8/finance/chart/<SYMBOL>`).
