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
2. `node --test tests/worker.contract.test.js` — Worker contract tests (conditional: prints "skipped" and exits 0 if the test file is absent; becomes unconditional after ticket 02 lands)
3. `wrangler deploy --dry-run --outdir /tmp/property-tracker-worker-build` — Worker bundle sanity
4. `npx --no-install playwright test` — Browser smoke (conditional: prints "skipped" and exits 0 if `tests/browser/` or `node_modules/@playwright` are absent; becomes unconditional after ticket 03 lands)

The conditional skips are what let the script run on a clean tree before all dependent tickets have landed. After all v1.2 tickets land, every stage runs unconditionally. See `docs/adr/0010-v1.2-testing-safety-net.md` for the architectural decisions.
