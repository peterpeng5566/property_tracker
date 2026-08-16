# 0018 — Multi-origin CORS allowlist + public `config.js`

## Status

Accepted (v1.8.x dev-experience follow-up; no schema / UI change)

## Context

Two small friction points stood in the way of running the app from a stable URL outside `localhost`:

1. **`config.js` was gitignored.** The file is loaded by `portfolio.html` via `<script src="config.js">` and holds the deployed Cloudflare Worker URL. As a result, anyone cloning the repo had to copy `config.js.example` → `config.js` and edit a value before Yahoo refresh would work. For users who just want to run the app against the maintainer's already-deployed Worker, this step is pure ceremony.

2. **`ALLOWED_ORIGIN` accepted a single origin only.** The Worker hardcoded `origin === env.ALLOWED_ORIGIN`. The maintainer develops on `http://localhost:8000` (and occasionally `:8080`); if the app were also served from `https://peterpeng5566.github.io` (GitHub Pages), the Worker would 403 every request from that origin. Adding a new origin meant editing `wrangler.toml` *and* redeploying *and* giving up the previous one — or accepting the maintenance burden of a "set the right env var for your machine" instruction in the README.

The two changes are paired: making `config.js` public means newcomers can run the app from any origin the Worker permits, and making the Worker permit multiple origins means those origins don't have to be planned ahead of time.

## Decision

### 1. `config.js` is no longer gitignored

- Remove `config.js` from `.gitignore`.
- The committed `config.js` carries the maintainer's deployed Worker URL as a working default. Comments explicitly say "override if you deploy your own Worker".
- `config.js.example` stays as a template (empty default + format documentation) — useful for newcomers who want to see the shape without diffing against a real value.

**Why not keep `config.js` gitignored and commit only `config.js.example`?**
- The Worker URL is not a secret — Workers are public endpoints and the URL alone grants only the ability to consume the proxy quota. There is no credential material in the file.
- Forcing every cloner to copy-and-edit creates a startup tax with zero security upside.
- The Worker itself enforces the allowlist via `ALLOWED_ORIGIN`; the URL being public does not weaken that gate.

**Why not put the URL in a build-time constant?**
- This is a single-file Web app with no build step. Adding one to inject `yahooProxyUrl` would be disproportionate.

### 2. `ALLOWED_ORIGIN` accepts multiple origins

`ALLOWED_ORIGIN` may be:

- A single string (backward compatible — e.g. `"http://localhost:8000"`).
- A comma-separated string (Cloudflare dashboard format — e.g. `"http://localhost:8000,https://peterpeng5566.github.io"`).
- A TOML array (`wrangler.toml` format — e.g. `["http://localhost:8000", "https://peterpeng5566.github.io"]`).

The Worker parses all three through one helper, `parseAllowedOrigins(raw)`, returning `null` (permissive default) or a non-empty string array. The dashboard and TOML formats are deliberately equivalent so users can switch tooling without rewriting values.

The CORS response header (`Access-Control-Allow-Origin`) uses the **multi-origin echo pattern**:

- If `ALLOWED_ORIGIN` is unset → `'*'` (unchanged from before).
- If the request `Origin` is in the allowlist → echo that origin.
- If `ALLOWED_ORIGIN` is set but the request has no `Origin` header (server-to-server / `curl` smoke tests) → the request passes through; the response echoes the first allowed entry.

This is the CORS-standard pattern for serving multiple allowlisted origins. `Access-Control-Allow-Origin: *` would also work for non-credentialed requests, but echoing the request origin keeps the response meaningful in browser DevTools and matches what every multi-origin CORS tutorial recommends.

**Origin-less requests bypass the allowlist intentionally.** CORS is a browser feature — non-browser HTTP clients (curl, scripts, server-to-server fetches) don't send `Origin`. Blocking them would break the curl smoke test in the README and any non-browser automation, with no security gain: the Host allowlist below already restricts the proxy's target URL space to Yahoo's chart and cookie hosts. Browser-based quota exhaustion is what `ALLOWED_ORIGIN` exists to prevent, and that's what it still prevents.

**Rejected: per-origin env vars (`ALLOWED_ORIGIN_1`, `ALLOWED_ORIGIN_2`, …).**
Adding a new origin would require a code change in the Worker. The whole point of the change is that adding origins is a config-only operation.

**Rejected: regex / glob matching.**
The origins we care about are concrete URLs (`http://localhost:8000`, `https://peterpeng5566.github.io`). Regex adds expressiveness no one needs and obscures the allowlist.

**Rejected: dropping the allowlist entirely.**
Already optional via `unset → '*'`. Users who want maximum openness can leave it unset. Users who want a closed Worker keep the gate; they just get to list more than one origin.

### 3. `wrangler.toml.example` added; `wrangler.toml` stays gitignored

`wrangler.toml` is gitignored because its `name` field binds the deployment to a specific Cloudflare account — committing it would either fail to deploy for anyone else or silently collide with the maintainer's Worker name. `wrangler.toml.example` is the template newcomers copy from, with the multi-origin `[vars]` block and commented hints for GitHub Pages / custom domain. Mirrors the existing `config.js.example` / `config.js` pattern.

## Consequences

### Positive

- Cloning the repo and opening `portfolio.html` works against the maintainer's Worker with no edits. The app's "first run" cost drops to zero for users who don't deploy their own Worker.
- Local dev on `:8000` and `:8080` and GitHub Pages can coexist — the same Worker handles all three once redeployed.
- The CORS contract is unchanged for single-origin users. Existing deployments keep working; only the env var's value shape changes if the user opts into multi-origin.

### Negative / known limitations

- The first entry of `ALLOWED_ORIGIN` becomes a *de facto* canonical fallback for origin-less requests. If the order is changed, the curl-smoke behavior changes. This is documented in the comment header of `yahoo-proxy.mjs` and `wrangler.toml.example`.
- The committed `config.js` is now coupled to the maintainer's Worker staying alive. If the maintainer's Worker is deleted or its quota is exhausted, every cloner sees Yahoo refresh fail with the existing graceful error message ("Yahoo proxy not configured..."). The error UX is already correct (it nudges users to the README), so the failure mode is recoverable rather than silent.
- `wrangler.toml` is still gitignored. Newcomers who want to deploy must copy `wrangler.toml.example` → `wrangler.toml` and edit `name`. This is intentional but worth flagging in onboarding.

### Trade-offs accepted

| Choice | Trade-off |
|---|---|
| Commit `config.js` with a real Worker URL | URL is now coupled to maintainer's uptime; one-line override for newcomers who deploy their own |
| Multi-origin via comma-separated OR TOML array | Two equivalent syntaxes (differentiated by deployment tool); one parser handles both |
| Echo request origin when allowlisted | Header value depends on request, complicates curl output; matches CORS multi-origin convention |
| Origin-less requests bypass the allowlist | Curl smoke tests work; quota protection still applies to browser clients (the main threat) |
| Fall back to first allowed entry on missing Origin | Order of `ALLOWED_ORIGIN` matters for smoke tests; documented |
| Keep `wrangler.toml` gitignored, add `.example` | Newcomers must copy a template; mirrors existing config.js pattern |

## Alternatives considered

- **Keep `config.js` gitignored, document the copy step** — already in place; rejected as unnecessary friction for a non-secret value.
- **Inject `yahooProxyUrl` via build step** — no build step in this project; rejected as disproportionate.
- **Per-origin env vars (`ALLOWED_ORIGIN_1`, …)** — adding an origin becomes a code change; rejected (§2).
- **Regex / glob matching** — no concrete use case for it; rejected (§2).
- **Drop the allowlist entirely** — already available via unset; rejected as not addressing the multi-origin need (§2).

## References

### Internal

- [`docs/workers/yahoo-proxy.mjs`](../workers/yahoo-proxy.mjs) — `parseAllowedOrigins`, `isOriginAllowed`, `corsHeaders` updated; header block documents the multi-origin behavior
- [`tests/worker.contract.test.js`](../../tests/worker.contract.test.js) — Test 3 extended to single / denied / unset / multi-string / multi-array / multi-denied / no-origin-fallback
- [`wrangler.toml.example`](../../wrangler.toml.example) — new template with multi-origin block and commented GitHub Pages / custom-domain hints
- [`wrangler.toml`](../../wrangler.toml) — gitignored; updated locally with multi-origin array (deployment-coupled, not committed)
- [`config.js`](../../config.js) — no longer gitignored; comment updated to reflect "shared default, override locally"
- [`.gitignore`](../../.gitignore) — `config.js` line removed; `wrangler.toml` line retained (account-coupled)
- [`README.md`](../../README.md) — Yahoo CORS proxy setup section updated with multi-origin examples (CLI + dashboard)
- [ADR 0017 §9](0017-rebalance-advisor.md) — additive changes don't bump schema; same principle applies here (no `data.version` change since this is a Worker config change, not a portfolio data change)

### Wayfinder decisions

This ADR captures the design decision for the maintainer's "deploy to GitHub Pages" goal. No multi-round grilling — the change is small enough that the design choices fall out from the CORS spec and the project's existing `config.js.example` / `config.js` template pattern. Future scope (custom domain wildcard support, regex origins, per-deployment manifests) is not contemplated and would warrant its own ADR if requested.
