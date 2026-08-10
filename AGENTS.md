## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Tests

Pure logic that doesn't depend on Alpine/DOM lives under `lib/`. After editing anything in `lib/`, run `./test.sh` (uses Node's built-in `node:test`, no npm install). `portfolio.html` Alpine methods that wrap `lib/` functions are thin shims — the source of truth for tested logic must stay in `lib/` so tests don't need a browser.

## Pre-commit safety net

Before any commit that touches `lib/`, `portfolio.html`, `docs/workers/`, `docs/adr/`, `AGENTS.md`, or any `tests/*` file, the agent runs `./scripts/safety-net.sh` and fixes any failure before committing. If a test is failing because the change is intentional, fix the test, do not skip it.

The script runs four stages in order:

1. `./test.sh` — unit tests on `lib/` modules
2. `node --test tests/worker.contract.test.js` — Worker contract tests
3. `wrangler deploy --dry-run --outdir /tmp/property-tracker-worker-build` — Worker bundle sanity
4. `npx --no-install playwright test` — Browser smoke against `./dev.sh 8000`

Stage 4 needs a Chromium binary. By default the config points at `/usr/bin/chromium` (system Chromium). Override with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`, or unset it and run `npx playwright install chromium` to use Playwright's bundled build (~150 MB download). Stage 4 also needs `python3` on PATH (used by `./dev.sh`).

See `docs/adr/0010-v1.2-testing-safety-net.md` for the architectural decisions.
