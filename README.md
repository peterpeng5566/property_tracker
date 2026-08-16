# Property Tracker

A personal net-worth tracker. Tracks stocks, cash, and debts with manual snapshots for trend analysis. Single-file Web companion, sync via Google Drive, zero backend.

## Status

- **v1.0** — sync complete. 4 pages (Home, Holdings, Cash & Debts, Categories). Import / Export / Sync I/O. Live as of 2026-08-09 (real client_id + Google Drive smoke test passed).
- **v1.1–v1.4** — pricing refresh + migration safety net (v1.1–v1.2), true-delete + automatic backups (v1.3), target-allocation plans + drift (v1.4).
- **v1.5** — Snapshot UI landed. 5th nav page (Snapshots) with list / detail (drill-in to holdings/cash/debts with frozen currency + orphan handling) / compare 2 snapshots (delta view) / trend chart (inline SVG sparkline with 2 polylines). Manual-only; snapshot cap (default 365, FIFO, user-configurable, `0 = unlimited`). See [`docs/adr/0014-snapshot-ui.md`](docs/adr/0014-snapshot-ui.md).
- **v1.6** — Manual record ordering landed. Per-collection ID array (`data.holdings_order` / `cash_accounts_order` / `debts_order`); ↑/↓ buttons on the Holdings / Cash / Debts pages with ARIA-correct disabled states. Lazy-write semantics (the array is absent until first reordering); sync-friendly prefer-remote merge (last-synced-wins on offline conflict). Categories and Plans pages are explicitly out of scope. See [`docs/adr/0015-record-ordering.md`](docs/adr/0015-record-ordering.md).
- **v1.7** — Categories + Settings sync merge landed. Categories gain per-record newer-wins merge with tombstone propagation (replaces the pre-v1.7 replace-from-remote limitation that silently wiped locally-added categories on stale pulls). Settings gain object-level newer-wins with edit-path-only stamps. Backward-compatible: no schema version bump; pre-v1.7 portfolios are lazy-backfilled on first load. See [`docs/adr/0016-categories-and-settings-sync.md`](docs/adr/0016-categories-and-settings-sync.md).
- **v1.8** — Region-aware rebalance advisor landed. Existing Plan rules gain an optional `target_weight_pct` field; a new top-level "Rebalance" nav consumes the active plan and produces per-record "buy/sell N shares" (or cash amount delta) advice, with a 52-week position indicator per holding candidate. Reuses the existing Categories attribute system (no new schema); cash is a first-class asset class. See [`docs/adr/0017-rebalance-advisor.md`](docs/adr/0017-rebalance-advisor.md).

## Run it

```bash
./dev.sh
# open http://localhost:8000/portfolio.html
```

Default port is 8000. Pass another as the first arg if 8000 is busy: `./dev.sh 8080`. The local server is required because Google OAuth rejects `file://` origins.

## Test it

```bash
./test.sh
```

Runs automated tests for `lib/format.js` (the compact suffix display rules: W/K/M/Y). Uses Node.js's built-in `node:test`. Requires Node 18+.

## Yahoo CORS proxy setup

Yahoo's `query1.finance.yahoo.com` does not send CORS-permitting headers, so the browser blocks the refresh button. v1.1 routes Yahoo requests through a tiny Cloudflare Worker. **One-time setup, ~5 minutes, free tier (100k req/day — you use ~10-50/day).**

The Worker uses Yahoo's `/v8/finance/chart/<SYMBOL>` endpoint (not the now-locked `/v7/finance/quote` batch endpoint) and makes one parallel request per holding. See [`docs/research/05-chart-endpoint.md`](docs/research/05-chart-endpoint.md) for endpoint rationale.

### Recommended path: Wrangler CLI (more reliable)

The Cloudflare dashboard's in-browser code editor (Monaco) sometimes mangles pasted code or mis-detects the module format. Wrangler CLI deploys the file as-is from your terminal. This is what Cloudflare's own engineers use.

**1. Install wrangler and get an API token:**

```bash
npm install -g wrangler
```

👉 Create an API token at **https://dash.cloudflare.com/profile/api-tokens** → **Create Token** → **Edit Cloudflare Workers** template → **Continue to summary** → **Create Token**. Copy the token.

**2. Set the token and deploy:**

```bash
export CLOUDFLARE_API_TOKEN='paste-your-token-here'
cd /path/to/property_tracker_web
wrangler deploy docs/workers/yahoo-proxy.mjs --name yahoo-proxy --compatibility-date 2025-01-01
```

Wrangler prints the URL: `https://yahoo-proxy.YOURACCOUNT.workers.dev`.

**3. Lock origin (recommended):** create a `wrangler.toml` (gitignored) in the repo root:

```toml
name = "yahoo-proxy"
main = "docs/workers/yahoo-proxy.mjs"
compatibility_date = "2025-01-01"

[vars]
ALLOWED_ORIGIN = "http://localhost:8000"   # or your production origin
```

Then redeploy with `wrangler deploy` (no flags needed — wrangler reads the toml).

**4. Configure the app:**

```bash
cp config.js.example config.js
# Edit config.js, paste your Worker URL into yahooProxyUrl
```

**5. Verify:** open `portfolio.html` via `./dev.sh`, click the **Refresh** button in the header. Prices should appear. DevTools Network tab should show N requests to your Worker URL.

Smoke test from terminal:
```bash
curl 'https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FAAPL%3Finterval%3D1d%26range%3D1d'
```
Should return Yahoo's JSON with CORS headers.

### Alternative: Dashboard editor (works but finicky)

If you prefer the dashboard UI over Wrangler CLI:

1. **Sign up** at [dash.cloudflare.com](https://dash.cloudflare.com) (no credit card, email + password only).
2. **Create Worker**: left sidebar → **Workers & Pages** → **Create application** → **Create Worker** → name it `yahoo-proxy` → **Deploy**.
3. **Paste code**: click **Edit Code** → select all → delete → paste the entire contents of [`docs/workers/yahoo-proxy.mjs`](docs/workers/yahoo-proxy.mjs) → **Save and Deploy**.
4. **Copy URL** from the dashboard. It looks like `https://yahoo-proxy.YOURACCOUNT.workers.dev`.
5. **(Optional but recommended) Lock origin**: dashboard → your Worker → **Settings** → **Variables** → add variable `ALLOWED_ORIGIN` = your app's origin (e.g. `http://localhost:8000` for dev, `https://YOURNAME.github.io` for production).
6. **Configure app**: copy `config.js.example` to `config.js` (the file is gitignored). Paste your Worker URL into `yahooProxyUrl`.

⚠️ **Known dashboard editor issues**:
- Pasted code sometimes appears doubled or partially missing — verify after paste.
- Module Worker format (`export default { fetch }`) may deploy as Service Worker format in some cases — verify with `wrangler tail` if you see "No event handlers registered" errors.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Banner: `Refresh failed: Yahoo proxy not configured...` | `config.js` not created from `config.js.example` | Copy `config.js.example` → `config.js`, paste Worker URL into `yahooProxyUrl` |
| `Failed to fetch` in browser | `config.js` exists but `yahooProxyUrl` is wrong/empty | Check the URL string in `config.js` (must start with `https://`) |
| Worker returns `403 forbidden` | `ALLOWED_ORIGIN` doesn't match your app origin | Update `ALLOWED_ORIGIN` in dashboard or `wrangler.toml` |
| Worker returns `502` / `error code: 1101` | Runtime exception in Worker | `wrangler tail` to see the actual error |
| Holdings stay `—` after refresh | Network blocked or Worker URL wrong | F12 → Network tab → check request URLs |

## Sync setup

Google Drive sync needs an OAuth Client ID. One-time setup (~10 min): see [docs/google-oauth-setup.md](docs/google-oauth-setup.md).

The Cloud Console's **Authorized JavaScript origins** must include the origin you open the app from. For local dev: `http://localhost:8000`.

## Data I/O — when to use what

| Method   | Use it for                                                            |
| -------- | --------------------------------------------------------------------- |
| Export   | Single-machine backup, share a snapshot, debug (the file is JSON)     |
| Import   | Restore from a backup, recover after a browser reset (replaces everything) |
| Sync     | Cross-device, ongoing. Pulls on open, auto-pushes on save (toggle in sync modal) |

All three speak the same JSON format. See [docs/data-file-format.md](docs/data-file-format.md).

## Storage

v1 stores the portfolio in `localStorage` under a single key (`property_tracker_portfolio_v1`). Sync reads/writes the same JSON to Google Drive as the source of truth. See [ADR 0007](docs/adr/0007-v1-web-storage-localstorage.md) and [ADR 0002](docs/adr/0002-google-drive-sync.md).

For the on-disk schema (fields, types, migration rules), see [docs/data-file-format.md](docs/data-file-format.md).

## Roadmap

_Last updated at v1.8 close-out._ The remaining open items are in the per-version issue trackers under `.scratch/`:

- `.scratch/v1.4-target-allocation-plans/map.md` — leaves "snapshot + active plan drift history" as open fog (a future effort, not on a version).
- `.scratch/v1.6-record-ordering/map.md` — v1.6 ships with 4 resolved tickets (data + lib + 3 UI pages + ADR/glossary/smoke). Categories / Plans reorder is deferred (ADR 0015 §5). Drag-and-drop is deferred (open until user complaint).
- `.scratch/v1.7-category-sync/map.md` — v1.7 ships with 2 resolved tickets (data + merge + tombstone + 3 settings edit-path stamps + ADR 0016 + glossary; backward-compat + 6 browser integration scenarios). Categories rename ties follow the same newer-wins rule as holdings/cash/debts/plans (ADR 0016 §9); pre-v1.7 clients lack tombstone mechanism (ADR 0016 §8); per-field Settings merge and per-value Categories merge are deferred as overkill.
- `.scratch/v1.8-region-aware-rebalance/map.md` — v1.8 ships with 3 resolved tickets (data layer + ADR 0017 + sync merge tests + 39 unit tests; Rebalance UI page + Plan editor `target_weight_pct` + 9 browser integration scenarios; docs + close-out). Lot-size enforcement is deferred (schema field pre-laid but no UI control — `.week52-bar` will consume it when added). Cash-residual destination is manual (user picks the destination cash account as part of the execute choice). Within-leaf priority ordering is deferred. Per-leaf sub-weights (per-holding weight override) are deferred.

## Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/adr/](docs/adr/) — architectural decisions (0001–0017)
- [docs/data-file-format.md](docs/data-file-format.md) — JSON file format spec
- [docs/google-oauth-setup.md](docs/google-oauth-setup.md) — Google Cloud Console setup
- [docs/agents/](docs/agents/) — agent / workflow conventions
