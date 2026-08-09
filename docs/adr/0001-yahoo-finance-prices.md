# 0001 — Yahoo Finance for prices (current + 52W + prev_close + FX)

## Status

Accepted (v1.1)

Updated from the original v1.0 ADR by [`.scratch/price-tracking/issues/06-update-adr-0001.md`](../.scratch/price-tracking/issues/06-update-adr-0001.md) to reflect v1.1's actual usage. The v1.0 chart endpoint was never implemented; v1.1 ships the batch endpoint.

## Context

v1.0 of the personal portfolio tracker had a placeholder for `current_price` per holding, but no automated fetch was implemented — the user entered prices manually. Yahoo Finance was chosen as the future fetch source (no API key, no quota, free).

v1.1 actually implements the fetch. The use cases are now:

- **Current price** (`current_price`) — every refresh
- **52-week high** (`high_52w`) — every refresh
- **52-week low** (`low_52w`) — every refresh
- **Previous close** (`prev_close`) — every refresh
- **TWD/USD FX rate** (`TWD=X`) — for display-currency conversion

The architecture question is: which Yahoo Finance endpoint, and what fields?

## Decision

### Use Yahoo Finance's unofficial `/v7/finance/quote` batch endpoint

```
GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,2330.TW,TWD=X&crumb=XXX
```

**Batch** — all symbols in a single call. Yahoo's quote endpoint natively supports multiple symbols via the `symbols=` query parameter. This means N+1 latency is amortized across all holdings.

### Auth: cookie + crumb (since late 2024)

Yahoo has required a `crumb` parameter and a valid cookie for `/v7/finance/quote` since late 2024. The bootstrap flow:

1. `GET https://fc.yahoo.com` → set cookie (one-time)
2. `GET https://query1.finance.yahoo.com/v1/test/getcrumb` → get crumb token
3. Append `&crumb=XXX` to every quote call excluding `spark` (which is crumb-free)

On 401 response, re-bootstrap once and retry. If still 401, surface as auth error.

This is a documented [community quirk](https://github.com/gadicc/node-yahoo-finance2/blob/devel/docs/crumb.md) of the unofficial API. Avoid by not depending on the API for production-critical paths.

### Symbols

- **US-listed stocks**: bare ticker, e.g. `AAPL`
- **Taiwan-listed stocks**: `{TICKER}.TW`, e.g. `2330.TW`
- **FX**: `TWD=X` (returns USD-per-TWD rate; invert to get TWD-per-USD)
- **Other markets**: research shows Yahoo supports `.KS` (Korea), `.HK` (Hong Kong), `.SS` / `.SZ` (Shanghai / Shenzhen), `.T` (Tokyo), etc. — same pattern as Taiwan. v1.1 does not formally support these but the Yahoo URL pattern is the same.

### Field name mapping

Yahoo's `/v7/finance/quote` response fields map to our schema as:

| Yahoo field | Our field |
|---|---|
| `quote.regularMarketPrice` | `current_price` |
| `quote.fiftyTwoWeekHigh` | `high_52w` |
| `quote.fiftyTwoWeekLow` | `low_52w` |
| `quote.regularMarketPreviousClose` | `prev_close` |
| `quote.currency` | (read into holding's `currency` for verification) |
| `quote.marketState` | (transient, not stored — see [ADR 0009](0009-v1.1-price-tracking.md) for intraday detection) |

### CORS limitation

Yahoo's `query1.finance.yahoo.com` does **not** send CORS-permitting headers for arbitrary origins. Implementation will need a fetch proxy (self-hosted, public CORS mirror, or browser extension). This is documented as a known limitation in [ADR 0009 §11](0009-v1.1-price-tracking.md#11-cors-for-yahoo-finance-documented-as-a-known-limitation). A future ticket / ADR should resolve this; v1.1 spec describes the implementation but the CORS proxy is a separate concern.

### Rejected alternatives

- **Official Yahoo Finance API** — requires OAuth, paid plan, and quota. Inappropriate for personal use.
- **Other free providers (Alpha Vantage, Finnhub, IEX)** — all require API keys (free tiers exist but have quotas). Same operational risk as Yahoo but with formal quotas.
- **Self-hosted scraper** — adds a backend (violates [ADR 0007](0007-v1-web-storage-localstorage.md) "no backend" constraint).
- **Per-symbol chart endpoint** (`/v8/finance/chart/{SYMBOL}`) — original v1.0 plan, rejected because:
  - Massive latency (N+1 calls)
  - Doesn't return `fiftyTwoWeekHigh` / `fiftyTwoWeekLow` / `regularMarketPreviousClose` in the same payload (requires multiple calls per symbol)
  - Same unofficial API risk as `/v7/finance/quote`

## Consequences

### Positive

- **No API key, no quota** — Yahoo's unofficial API is free and unlimited (rate-limited in practice, but no formal quota)
- **One call covers all holdings** — Yahoo's batch endpoint supports `symbols=A,B,C` natively
- **5 fields per holding** — `current_price`, `high_52w`, `low_52w`, `prev_close`, and `marketState` (transient) come in one call
- **Test fixture** — `lib/yahoo.js` takes a fetch function (DI), so tests can pass canned Yahoo responses

### Negative

- **Unofficial API** — can break anytime, no SLA, no support. This is the dominant risk of v1.1.
- **Crumb auth** — added ceremony since late 2024. Implementation must handle cookie + crumb bootstrap with retry.
- **CORS** — Yahoo does not send CORS headers; browser fetch will fail without a proxy. See [ADR 0009 §11](0009-v1.1-price-tracking.md#11-cors-for-yahoo-finance-documented-as-a-known-limitation).
- **Silent drop on invalid symbols** — a typo in `ticker` is silently missing from the response. We treat "missing" as "failed" (the holding gets a red badge). User-visible but not loud.
- **Field name shenanigans** — `regularMarketPreviousClose` (not `previousClose` or `prevClose`) is the actual Yahoo field name. Implementation must use the exact names.
- **Persistence of deprecation risk** — every new field added is more surface area for Yahoo to break. 4 fields + FX = 5 fetch points.

### Trade-offs accepted

- **Unofficial API > official one** — no API key, no quota, but fragile. Acceptable for personal use.
- **Crumb + cookie > none** — Yahoo's auth requirement is an additional 2 requests on first refresh and 1 retry on 401. Acceptable cost.
- **Batch > per-symbol** — single call, lower latency, but one symbol's failure mode is more complex (silent drop vs HTTP error).
- **5 fields per refresh > 1** — payload grows linearly with holdings, but Yahoo's endpoint is designed for this.

## Deferred / future

- **CORS resolution** — separate ticket; this ADR does not solve it (see [ADR 0009 §11](0009-v1.1-price-tracking.md#11-cors-for-yahoo-finance-documented-as-a-known-limitation))
- **Auto-refresh on page open or timer** — manual button only in v1.1; v1.2+ may add timer
- **Streaming prices** — WebSocket or SSE; deferred to v1.2+
- **Multi-provider fallback** — if Yahoo breaks, fall back to Alpha Vantage / Finnhub. Today: single point of failure.
- **Ticker auto-detection / correction** — user still types manually. v1.1 does not auto-correct typos.

## References

- [ADR 0009 — v1.1 price tracking](0009-v1.1-price-tracking.md) — v1.1-specific architecture (bulk refresh, retry, partial success, snapshot, header layout)
- [ADR 0007 — v1 web storage localStorage](0007-v1-web-storage-localstorage.md) — "no backend" constraint
- [`.scratch/price-tracking/research/02-yahoo-batch-endpoint.md`](../.scratch/price-tracking/research/02-yahoo-batch-endpoint.md) — research behind the endpoint choice
- [`.scratch/price-tracking/schema-section.md`](../.scratch/price-tracking/schema-section.md) — schema for the 4 fields
- [`.scratch/price-tracking/spec.md`](../.scratch/price-tracking/spec.md) — full v1.1 spec
- Yahoo Finance unofficial API — public knowledge, no docs
- [Yahoo crumb auth flow (community documentation)](https://github.com/gadicc/node-yahoo-finance2/blob/devel/docs/crumb.md)
- [Yahoo Finance quote endpoint field names (community documentation)](https://stackoverflow.com/q/63130178)

## History

- **v1.0** (original): "Yahoo Finance chart API for prices" — documented `/v8/finance/chart/{SYMBOL}` as the intended endpoint. Never implemented.
- **v1.1** (this update): switch to `/v7/finance/quote?symbols=...` batch endpoint, add 52W + prev_close fields, document crumb auth and CORS limitation.
