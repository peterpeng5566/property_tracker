# Property Tracker

A personal net-worth tracker. Tracks stocks, cash, and debts with manual snapshots for trend analysis. Single-file Web companion, sync via Google Drive, zero backend.

## Status

- **v1.0** — sync complete. 4 pages (Home, Holdings, Cash & Debts, Categories). Import / Export / Sync I/O. Live as of 2026-08-09 (real client_id + Google Drive smoke test passed).

## Run it

```bash
./dev.sh
# open http://localhost:8000/portfolio.html
```

Default port is 8000. Pass another as the first arg if 8000 is busy: `./dev.sh 8080`. The local server is required because Google OAuth rejects `file://` origins.

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

- **v1.1** — snapshot UI + comparison view + charts (the `snapshots` field is reserved but unused in v1.0). Includes snapshot creation flow, delta vs previous snapshot, and trend charts.

## Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/adr/](docs/adr/) — architectural decisions (0001–0008)
- [docs/data-file-format.md](docs/data-file-format.md) — JSON file format spec
- [docs/google-oauth-setup.md](docs/google-oauth-setup.md) — Google Cloud Console setup
- [docs/agents/](docs/agents/) — agent / workflow conventions
