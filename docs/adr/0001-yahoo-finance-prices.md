# Yahoo Finance chart API for prices

Stock and FX prices are fetched from the unofficial Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}`). No API key required. Symbols use `{TICKER}.TW` for Taiwan-listed stocks (e.g. `2330.TW`) and bare tickers for US-listed (e.g. `AAPL`). FX rate comes from `TWD=X`.

This is the unofficial API. It can change or rate-limit without notice. Acceptable for a personal-use app; inappropriate for a commercial product.
