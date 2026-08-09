## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Tests

Pure logic that doesn't depend on Alpine/DOM lives under `lib/`. After editing anything in `lib/`, run `./test.sh` (uses Node's built-in `node:test`, no npm install). `portfolio.html` Alpine methods that wrap `lib/` functions are thin shims — the source of truth for tested logic must stay in `lib/` so tests don't need a browser.
