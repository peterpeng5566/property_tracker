# Property Tracker

A personal net-worth tracker. Tracks stocks, cash, and debts with manual snapshots for trend analysis. Single-file Web companion, sync via Google Drive, zero backend.

## Status

- **v1.0** — sync complete. 4 pages (Home, Holdings, Cash & Debts, Categories). Import / Export / Sync I/O. Live as of 2026-08-09 (real client_id + Google Drive smoke test passed).
- **v1.1–v1.4** — pricing refresh + migration safety net (v1.1–v1.2), true-delete + automatic backups (v1.3), target-allocation plans + drift (v1.4).
- **v1.5** — Snapshot UI landed. 5th nav page (Snapshots) with list / detail (drill-in to holdings/cash/debts with frozen currency + orphan handling) / compare 2 snapshots (delta view) / trend chart (inline SVG sparkline with 2 polylines). Manual-only; snapshot cap (default 365, FIFO, user-configurable, `0 = unlimited`). See [`docs/adr/0014-snapshot-ui.md`](docs/adr/0014-snapshot-ui.md).
- **v1.6** — Manual record ordering landed. Per-collection ID array (`data.holdings_order` / `cash_accounts_order` / `debts_order`); ↑/↓ buttons on the Holdings / Cash / Debts pages with ARIA-correct disabled states. Lazy-write semantics (the array is absent until first reordering); sync-friendly prefer-remote merge (last-synced-wins on offline conflict). Categories and Plans pages are explicitly out of scope. See [`docs/adr/0015-record-ordering.md`](docs/adr/0015-record-ordering.md).
- **v1.7** — Categories + Settings sync merge landed. Categories gain per-record newer-wins merge with tombstone propagation (replaces the pre-v1.7 replace-from-remote limitation that silently wiped locally-added categories on stale pulls). Settings gain object-level newer-wins with edit-path-only stamps. Backward-compatible: no schema version bump; pre-v1.7 portfolios are lazy-backfilled on first load. See [`docs/adr/0016-categories-and-settings-sync.md`](docs/adr/0016-categories-and-settings-sync.md).
- **v1.8** — Region-aware rebalance advisor landed. Existing Plan rules gain an optional `target_weight_pct` field; a new top-level "Rebalance" nav consumes the active plan and produces per-record "buy/sell N shares" (or cash amount delta) advice, with a 52-week position indicator per holding candidate. Reuses the existing Categories attribute system (no new schema); cash is a first-class asset class. See [`docs/adr/0017-rebalance-advisor.md`](docs/adr/0017-rebalance-advisor.md).
- **v1.9** — Mobile responsiveness landed. 414 px (iPhone Plus / Max) is now a usable viewport. The second-row 8-tab nav is replaced at < md by a left-side hamburger + right-side slide-in drawer + backdrop; the Holdings / Cash / Debts / Plans drift / Rebalance candidate tables collapse into per-record stacked cards with `<details>` for secondary fields; independent action buttons get ≥44 pt touch targets; HTML `<details>/<summary>` is the only collapse primitive (zero Alpine state for cosmetic toggling). Same data source; same desktop layout verbatim. Schema stays `'1.1'` — v1.9 is layout-only, no version bump per ADR 0009 §6. Audit-first process (T01 produced `audit-report.md` + 13 screenshots + the smoke regression net; T02 acted on the hot list). See [`docs/adr/0020-mobile-responsiveness.md`](docs/adr/0020-mobile-responsiveness.md).
- **v1.10** — i18n modal placeholders + dispatchEvent anti-pattern guard landed. All `placeholder="..."` strings in the Add Cash / Add Debt / Add Holding / Plan editor inputs are now routed through the i18n bundle (`t('...')`) so EN-locale users no longer see Chinese placeholder text (or `□□□□□□` in CJK-glyph-less environments). Schema stays `'1.1'`. A new unit test (`tests/dispatch-event-guard.test.js`) scans `tests/browser/*.spec.js` for `dispatchEvent(` / `new MouseEvent(` patterns and fails stage 1 of the safety net if any are reintroduced — codifies the v1.9.1 hotfix lesson (`ba757da`) that synthetic-click workarounds mask production race conditions. No ADR; 0 production code change in the guard commit. See `.scratch/v1.10-i18n-modal-placeholders/` and `.scratch/v1.10-dispatch-event-guard/`.
- **v1.11** — Known-limitations registry. Per user direction ("Taiwan ETF price-fetch 這測試部分沒問題"), the Taiwan ETF Yahoo 429 ticket is filed as `Status: wontfix` rather than an active incident. The test infrastructure for Yahoo price-fetch is complete (19 yahoo tests + 18 refresh tests + browser integration smoke — all green), the upstream Yahoo IP-level rate limit on TWSE-listed bond ETFs (`00687B.TWO` / `00695B.TWO` / `00719B.TWO`) is accepted as a known limitation, and `CONTEXT.md` gains a canonical "Known limitation" glossary entry under `## Sync`. No schema, lib/, or production code change. See `.scratch/v1.11-known-limitations/issues/01-taiwan-etf-yahoo-429.md`.
- **v1.12** — Sync auto-pull. After Drive auth lands, the client now pulls the cloud's newer state automatically (previously only the push half of "pull-on-open, push-on-save" was implemented; the user had to restore from a backup when the cloud was newer). Implementation: a guarded `$watch('syncStatus', ...)` in `init()` fires `syncNow()` on the rising-edge into `connected`, with three guards (skip `oldVal === 'connected'`, `oldVal === 'syncing'`, no token) preventing re-entry. Two pre-existing bugs uncovered and fixed in the same commit: (a) `init()` ran twice per page load (Alpine 3 auto-init + explicit `x-init`), now idempotent via a `_initialized` flag; (b) `load()` was not persisted without the double-init side effect, now explicit `this.save()`. Schema stays `'1.1'`. 121 → 123 browser smoke. See `.scratch/v1.12-sync-auto-pull/issues/01-open-does-not-pull-latest-from-drive.md`.
- **v1.13** — Mobile header polish. The header right cluster is now compact at < md: 207 px → 77 px tall (3× reduction), 4–5 wrap rows → 1 row, refresh + sync buttons upgraded to 44×44 pt touch target. The `⋯` menu closes on click-outside (was: only re-toggling the summary worked). A pre-existing CSS leak was fixed: the global `summary::before { content: '+' }` rule (added in v1.9 for mobile stacked cards) was rendering the header `⋯` menu as `+ ⋯`; now scoped via `:not(.header-menu)`. Language + Currency moved from the header to a new Settings section at the bottom of the drawer (mobile only — desktop unchanged). Subtitle hidden at < md; title 16 px at < md / 20 px at ≥ md. Sync button split into icon + text spans via two new getters (`syncStatusIcon` / `syncStatusText`) so it renders icon-only at < md with no i18n table duplication. Schema stays `'1.1'`. 123 → 136 browser smoke. See `.scratch/v1.13-mobile-header-polish/issues/01-mobile-header-polish.md`.
- **v1.14** — Act vs measure: per-share stock facts in native currency. Holdings per-share fields (`cost/share`, `price/share`, 52w `low`/`high`) now render in the holding's **listing currency** regardless of the TWD/USD toggle — a USD-listed holding's $50 cost/share shows `$50.00` whether displayCurrency is TWD or USD. Position-level aggregates (`value`, `gain/loss`) and cash/debt balances continue to convert to displayCurrency so the portfolio rollup stays consistent. The split is the same rule that ADR 0017 §6 established for the Rebalance page; v1.14 retires the inconsistency that v1.8 left behind by switching 10 call sites from `formatAmount(h.x, h.currency)` to the existing `formatAmountNative(...)` shim. No schema change. `lib/format.js` unchanged (the `formatAmount(amount, src, src, fx)` path was already covered by the existing unit tests). 136 → 140 browser smoke (`tests/browser/holdings-currency.spec.js`). `CONTEXT.md` "Display currency" entry rewritten to match the rule. See [`docs/adr/0021-act-vs-measure.md`](docs/adr/0021-act-vs-measure.md) and `.scratch/v1.14-act-vs-measure/issues/01-act-vs-measure.md`.

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

**3. Lock origin (recommended):** create a `wrangler.toml` (gitignored) in the repo root. Use [`wrangler.toml.example`](wrangler.toml.example) as the template:

```toml
name = "yahoo-proxy"
main = "docs/workers/yahoo-proxy.mjs"
compatibility_date = "2025-01-01"

[vars]
# Multiple origins supported: TOML array (shown) or comma-separated string.
ALLOWED_ORIGIN = [
  "http://localhost:8000",       # dev server default
  "https://YOURNAME.github.io",  # GitHub Pages — replace with your GitHub username
  # "https://your.domain",        # add when using a custom domain
]
```

Then redeploy with `wrangler deploy` (no flags needed — wrangler reads the toml).

**4. Configure the app:**

```bash
cp config.js.example config.js
# Edit config.js, paste your Worker URL into yahooProxyUrl
```

The committed [`config.js`](config.js) already has the maintainer's deployed Worker URL as a working default — only override this if you deploy your own Worker. Newcomers running the app as-is can skip this step entirely (the file is no longer gitignored).

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
5. **(Optional but recommended) Lock origin**: dashboard → your Worker → **Settings** → **Variables** → add variable `ALLOWED_ORIGIN` = your app's origin. Comma-separated for multiple origins, e.g. `http://localhost:8000,https://YOURNAME.github.io` for dev + GitHub Pages.
6. **(Optional but recommended) Rate limit** (see ADR 0019): if you copy `wrangler.toml.example` → `wrangler.toml` and `wrangler deploy`, the Worker picks up the `RATE_LIMITER` binding (100 req / 60s per IP). Without it, the check is a no-op and your Worker is exposed to anyone who learns the URL.
7. **Configure app**: copy `config.js.example` to `config.js` (the file is gitignored). Paste your Worker URL into `yahooProxyUrl`.

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

_Last updated at v1.14 close-out._ The remaining open items are in the per-version issue trackers under `.scratch/`:

- `.scratch/v1.4-target-allocation-plans/map.md` — leaves "snapshot + active plan drift history" as open fog (a future effort, not on a version).
- `.scratch/v1.6-record-ordering/map.md` — v1.6 ships with 4 resolved tickets (data + lib + 3 UI pages + ADR/glossary/smoke). Categories / Plans reorder is deferred (ADR 0015 §5). Drag-and-drop is deferred (open until user complaint).
- `.scratch/v1.7-category-sync/map.md` — v1.7 ships with 2 resolved tickets (data + merge + tombstone + 3 settings edit-path stamps + ADR 0016 + glossary; backward-compat + 6 browser integration scenarios). Categories rename ties follow the same newer-wins rule as holdings/cash/debts/plans (ADR 0016 §9); pre-v1.7 clients lack tombstone mechanism (ADR 0016 §8); per-field Settings merge and per-value Categories merge are deferred as overkill.
- `.scratch/v1.8-region-aware-rebalance/map.md` — v1.8 ships with 3 resolved tickets (data layer + ADR 0017 + sync merge tests + 39 unit tests; Rebalance UI page + Plan editor `target_weight_pct` + 9 browser integration scenarios; docs + close-out). Lot-size enforcement is deferred (schema field pre-laid but no UI control — `.week52-bar` will consume it when added). Cash-residual destination is manual (user picks the destination cash account as part of the execute choice). Within-leaf priority ordering is deferred. Per-leaf sub-weights (per-holding weight override) are deferred.
- `.scratch/v1.9-mobile-responsiveness/map.md` — v1.9 ships with 2 resolved tickets (T01 audit script + 9-page overflow smoke + 13 screenshots + 18-item hot list; T02 commits 1-6 for regression net → header hamburger drawer → page-by-page table→card conversions → ADR 0020 + 5 glossary entries under `## Mobile` + README bump + map close-out). Modal Cancel/Save touch targets are within-45-px accepted (surrounding modal padding compensates). 320 px / 360 px floor is deferred (no observed user requirement). Tablet portrait (768–1024 px) is treated as desktop via the existing `md:` Tailwind utility.
- `.scratch/v1.10-i18n-modal-placeholders/` — v1.10 ships with 2 resolved tickets (Add Cash + Add Debt name placeholders; Add Holding modal 3 inputs + Plan editor rule name). All hardcoded `placeholder="..."` strings in `portfolio.html` are now routed through the i18n bundle.
- `.scratch/v1.10-dispatch-event-guard/issues/01-dispatch-event-guard.md` — v1.10 ships with a regression guard: `tests/dispatch-event-guard.test.js` codifies the v1.9.1 hotfix lesson (`ba757da`) that synthetic-click workarounds mask production race conditions. Scans `tests/browser/*.spec.js` for `dispatchEvent(` / `new MouseEvent(` and fails the safety net if any are reintroduced.
- `.scratch/v1.11-known-limitations/issues/01-taiwan-etf-yahoo-429.md` — **wontfix**. Yahoo Finance rate-limits TWSE-listed bond ETFs (`00687B.TWO` / `00695B.TWO` / `00719B.TWO`) at the IP level with HTTP 429; our Cloudflare Worker cannot bypass this (it's upstream of our network shape). Test coverage is complete: 19 yahoo tests + 18 refresh tests + browser integration smoke — all green. Workaround: manual price entry via the holding modal "Current Price / share" field. No schema, lib/, or production code change needed.
- `.scratch/v1.12-sync-auto-pull/issues/01-open-does-not-pull-latest-from-drive.md` — v1.12 ships with 1 resolved ticket (auto-pull on `syncStatus` rising-edge into `connected`). The fix also closes two pre-existing bugs uncovered during testing: (a) `init()` running twice per page load (Alpine 3 auto-init + explicit `x-init`); (b) `load()` not persisting migrations without the double-init side effect. Both bugs are now fixed in `init()` directly. `_initialized` flag for idempotency; explicit `this.save()` after `this.load()`.
- `.scratch/v1.13-mobile-header-polish/issues/01-mobile-header-polish.md` — v1.13 ships with 1 resolved ticket (compact icon strip + click-outside for the `⋯` menu + CSS leak fix for `summary::before` + drawer Settings section for Language + Currency). Header height 207 px → 77 px; 13 new browser tests cover the click-outside close behaviour, the CSS scope opt-out, the mobile compactness rules, the desktop ≥ md sanity, and the drawer Settings reachability. No schema, lib/, or new dependency change.
- `.scratch/v1.14-act-vs-measure/issues/01-act-vs-measure.md` — v1.14 ships with 1 resolved ticket (per-share stock facts stay in listing currency; position totals stay in displayCurrency). 10 call sites in Holdings table / mobile card / snapshot detail holdings switch from `formatAmount` to `formatAmountNative`. ADR 0021 codifies the rule cross-cuttingly. 4 new browser tests (Holdings USD holding native; Holdings value/gain still converts; Holdings TWD holding native; snapshot detail holdings USD native). No schema, `lib/`, or new dependency change.

## Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/adr/](docs/adr/) — architectural decisions (0001–0020)
- [docs/data-file-format.md](docs/data-file-format.md) — JSON file format spec
- [docs/google-oauth-setup.md](docs/google-oauth-setup.md) — Google Cloud Console setup
- [docs/agents/](docs/agents/) — agent / workflow conventions
