# 05 — Yahoo `/v8/finance/chart/<SYMBOL>` endpoint

Type: research
Status: resolved
Blocked by: —

## Question

Does Yahoo Finance have a public, no-auth endpoint we can use for refresh
pricing after the `/v7/finance/quote` endpoint got locked behind crumb auth?

## Background

In 2025, Yahoo locked `/v7/finance/quote` (and its sibling crumb endpoint
`/v1/test/getcrumb`) behind browser-session-derived crumb auth. From a
Cloudflare Worker we get:

```
GET https://query1.finance.yahoo.com/v1/test/getcrumb
  → HTTP 401 Unauthorized
```

The chart endpoint, by contrast, is what powers Yahoo's embed widgets and
their `finance.yahoo.com/quote/AAPL` pages. It's documented to be publicly
accessible — Yahoo wants it to be reachable from browsers and embed code.

## Method

Manual experimentation against `query1.finance.yahoo.com` from Cloudflare
Workers runtime (with the consent cookie + a Mozilla UA, which Yahoo
requires for non-browser clients).

## Findings

### Chart endpoint works without crumb auth

```http
GET /v8/finance/chart/AAPL?interval=1d&range=1d HTTP/1.1
Host: query1.finance.yahoo.com
Cookie: A3=d=...&S=...
User-Agent: Mozilla/5.0

HTTP/1.1 200 OK
Content-Type: application/json;charset=utf-8
```

Returns the full meta object:

```json
{
  "chart": {
    "result": [{
      "meta": {
        "currency": "USD",
        "symbol": "AAPL",
        "regularMarketPrice": 313.33,
        "fiftyTwoWeekHigh": 344.57,
        "fiftyTwoWeekLow": 223.78,
        "chartPreviousClose": 312.41,
        "regularMarketTime": 1786132801,
        "gmtoffset": -14400,
        "currentTradingPeriod": {
          "pre":    { "start": ..., "end": ... },
          "regular": { "start": ..., "end": ... },
          "post":   { "start": ..., "end": ... }
        },
        "instrumentType": "EQUITY"
      },
      "timestamp": [...],
      "indicators": { ... }
    }],
    "error": null
  }
}
```

All the fields we need are present in `meta`:

| Need | Chart field |
|---|---|
| `current_price` | `regularMarketPrice` |
| `high_52w` | `fiftyTwoWeekHigh` |
| `low_52w` | `fiftyTwoWeekLow` |
| `prev_close` | `chartPreviousClose` |
| market state | derived from `currentTradingPeriod` + `gmtoffset` |
| FX detection | `instrumentType === 'CURRENCY'` |

### Chart endpoint does NOT batch

```http
GET /v8/finance/chart/AAPL,MSFT,GOOG?interval=1d&range=1d HTTP/1.1
→ HTTP 404 {"chart":{"result":null,"error":{"code":"Not Found"}}}
```

Each ticker must be its own request. For a personal portfolio (10–30
holdings) this is fine — 10 parallel requests take ~500ms total.

### Quote endpoint is locked

```
GET /v7/finance/quote?symbols=AAPL     → HTTP 401 Unauthorized
GET /v1/test/getcrumb                  → HTTP 401 Unauthorized
```

Both require browser-session-derived crumb auth that we can't replicate
from a Worker.

### FX symbols work

```http
GET /v8/finance/chart/TWD=X?interval=1d&range=1d
→ 200, instrumentType=CURRENCY, currency=TWD
```

### Bad tickers return 404 (not 200 with empty result)

```http
GET /v8/finance/chart/NOTREAL_XYZ
→ 404 {"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}
```

The Worker passes this 404 through unchanged with CORS headers. The
browser-side lib maps `!res.ok` to `{failed: true}` per symbol.

## Conclusion

Switch from `/v7/finance/quote` to `/v8/finance/chart/<SYMBOL>`. Per-symbol
fetch (parallel) instead of batch. Derive `marketState` from
`currentTradingPeriod` + `gmtoffset` since chart endpoint doesn't return it
directly.

This is an undocumented change vs. the v1.1 spec (which assumed the quote
endpoint). The behavioral change for users is invisible — same fields,
same UI. Implementation tickets #10/11/12 (refresh, table, intraday)
continue to work; only `lib/yahoo.js` + `docs/workers/yahoo-proxy.js` need
to change.

## References

- research/02-yahoo-batch-endpoint.md — original quote-endpoint research,
  now deprecated
- ADR 0001 v1.1 — updated to reflect chart endpoint
- ADR 0009 §2 — updated to reflect chart endpoint
