# 0019 — Per-IP rate limit + public-repo clean history

## Status

Accepted (deployed alongside the Actions-based deploy pipeline introduced
between ADR 0018 and now; no schema / UI / runtime-API change for the user).

## Context

After ADR 0018 the Worker's URL was no longer a secret: `config.js` carried
the URL in plain text and was committed to the repo. For a personal-use
project that is fine, but two threats remain even with a hardened CORS
allowlist (`ALLOWED_ORIGIN`):

1. **Browser-side CORS only blocks browsers, not `curl`.** The `ALLOWED_ORIGIN`
   allowlist gates every *browser* request, since browsers will send the
   `Origin` header. But `curl` from any IP, without an `Origin` header, is
   treated by the Worker as origin-less and bypasses the allowlist (an
   intentional choice — see ADR 0018 — so the README's `curl` smoke test
   works). Anyone who learns the URL can therefore drain the worker's
   100k/day free-tier quota from a script.

2. **Going public exposes the URL.** With `config.js` committed, the URL is
   visible to anyone with read access to the repo. The protection is that
   making the repo public was deferred until the URL was pulled out of
   `config.js` (now done via the GitHub Actions deploy workflow, which
   injects `YAHOO_PROXY_URL` from a secret at deploy time). But even with
   the URL out of tracked files, anyone who has *seen* the URL in the past
   (a contributor, a forked commit, the force-pushed history pre-cleanup)
   can keep using it.

The two threats don't add up to a credentials leak — the URL grants only the
ability to consume the proxy's quota — but a long-running script hammering
the URL is a concrete risk: on a busy day it could exhaust the daily quota
and the legitimate user (single-IP, ~50 req/day) would see every Refresh
button fail with a 502 from Cloudflare.

This ADR records the decision to add a **per-IP rate limit** inside the
Worker and the **history-cleanup rewrite** (filter-repo) needed before the
repo could be made public.

## Decision

### 1. Cloudflare Workers Rate Limiting binding (`[[ratelimits]]`)

The Worker is extended with the built-in `RATE_LIMITER` binding, declared
in `wrangler.toml`:

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 100, period = 60 }
```

100 req/60s per `CF-Connecting-IP`. The Worker (in `handleRequest`) checks
the binding after the origin allowlist and before the CORS preflight /
method / host checks; on `success = false` it returns `429 rate limited`
*with* CORS headers so the browser surfaces a clean error rather than an
opaque CORS failure.

### 2. Optional binding: dev mode stays unbroken

`isRateLimited(request, env)` returns `false` early when `env.RATE_LIMITER`
is undefined. Result:

- Production Worker (binding declared) → 100/60s enforced per IP.
- Local dev (`wrangler dev`, contract tests) → no binding, no enforcement.
- Future removal of the binding (or wrangler fallback) → Worker still works,
  just without the limit. **No code path becomes more brittle if the
  binding is ever absent or breaks.**

### 3. Fail open on binding errors

If `env.RATE_LIMITER.limit()` itself throws (e.g. transient Cloudflare-side
error), `isRateLimited` swallows the exception and returns `false`. A
quota-protection outage would be worse than no quota protection — a
misbehaving limiter should never turn the Worker into a 500-stream.

### 4. Limit value: 100 req / 60s

A single Refresh click in the app fires ~30 parallel requests (one per
holding); a single user will burn 10–30 req/click, well under 100 even
with several Refreshes in a minute. 100/60s caps a runaway script (or
leaked token) within ~3 seconds of full-speed abuse, while leaving
legitimate user behaviour untouched.

**Rejected: 1000 / 60s.** Effectively no protection — a script can do
~1000 RPS in a flat loop and only pause at 1-minute intervals.

**Rejected: 10 / 60s.** Too tight — a single Refresh click with 30
holdings plus a few retries would push the user into 429s, and the app
would need to add a delay loop. Personal use, not rate-of-mercy.

### 5. Apply before CORS preflight

Rate limit runs *before* `OPTIONS` preflight handling. Both browser
preflights and the underlying app requests count toward the bucket, which
matches reality — every Worker invocation counts toward the 100k/day quota,
including preflights. A spammed preflight would otherwise be free at the
quota level.

### 6. History cleanup before going public

Even with the rate limit in place, making the repo public with `config.js`
in the git history would re-introduce threat #2 (URL visible to anyone who
clicks "history" or any blame). The repo history was rewritten with
`git filter-repo --path config.js --invert-paths` to delete the file from
every commit, and a `--message-callback` to remove the URL string from
commit-message bodies. The `config.js` row was then deleted from the
working tree (file retained locally), `.gitignore` was updated to keep the
file untracked, and a fresh `backup-before-actions-inject` tag was taken
before the rewrite (the pre-existing `backup-before-anonymize` tag was
already from a prior filter-repo pass and was rewritten along with the
history).

### 7. Actions-based deploy of `config.js`

The deploy pipeline (`.github/workflows/deploy.yml`) materialises
`config.js` from a GitHub Actions secret (`YAHOO_PROXY_URL`) at deploy
time and then deploys the resulting tree to GitHub Pages. The secret is
the **only** place the URL lives outside the Worker's own runtime; it is
not in tracked files, not in commit messages, and not visible on the
deployed Pages site beyond the runtime fetch by `portfolio.html`.

## Consequences

### Positive

- **Quota is genuinely protected.** A scripted attacker at the public URL
  hits 429 within ~3 seconds of starting, regardless of whether they're
  coming via `curl` (allowlist-bypassing) or a browser.
- **Single user is unaffected.** 100/60s is 10–100× headroom over a
  user's real Refresh use.
- **No paid plan required.** The Workers Rate Limiting binding works on
  the Workers Free plan (verified via aggressive smoke test: 500 parallel
  requests from one IP returned 200 × 324 + 429 × 176).
- **Defense in depth.** CORS allowlist (ADR 0018) blocks browser-based
  cross-origin abuse; rate limit blocks everything else.

### Negative

- **`[[ratelimits]]` is a Cloudflare-side resource.** Removing the binding
  without also removing the Worker code's check won't change runtime
  behaviour (the check is no-op), but the orphaned namespace sits in the
  Cloudflare dashboard. Cosmetic, not broken.
- **Couples the Worker to wrangler 3.91+.** `[[ratelimits]]` is newer
  syntax than `[[unsafe.bindings]] type = "ratelimit"`. Both forms exist
  in the wild; the chosen form is what current wrangler 4.x accepts.
- **Per-IP granularity is approximate.** `CF-Connecting-IP` is the
  immediate client to Cloudflare, which is normally the user's egress IP
  but can be wrong under WARP or behind a corporate proxy. Good enough for
  protecting a personal-use Worker.

## Alternatives considered

### WAF Rate Limiting rules (zone-level)

WAF rules (free plan: one rule) protect traffic through *your* Cloudflare
zone (a domain you own). They do *not* protect `workers.dev` subdomains,
which are not proxied through any user-owned zone. So WAF rules are
useless for a default-routing Worker like this one. (They become useful
once a custom domain is attached to the Worker — a future option, not
done here.)

### Turnstile

A browser-side CAPTCHA could gate the request at the app layer, but
`portfolio.html`'s Refresh button is the user and the user is a human — so
Turnstile on the *proxy* would mean making the user fill a CAPTCHA on
every Refresh, which is unacceptable. Turnstile on the *app* (the
GitHub Pages site) would gate the same user who already proved humanness
the moment they typed the URL; not useful for the abuse model here (curl).

### KV-based counter (custom rate limiter)

Possible on Free plan via KV, but: (a) KV reads/writes cost plan quota
(separate from the 100k/day Worker invocation quota), which makes the
budget rather than the protection cheaper; (b) eventual-consistency
windows make precise per-minute accounting flaky; (c) it's reinventing
what Cloudflare already provides. Rejected.

### Accept the risk + monitor

Status quo without this change. Rejected because the trigger ("a script
just hammered your Worker all day") is invisible until the user notices a
broken Refresh button *and* checks the dashboard, by which time the
budget is gone.

## Verification

Deployed live:

- Worker version: `8f401f7a-02b9-4bca-857a-f93081c5f867`
- Smoke tests: single, two, three, and 500-request burst all behave as
  expected (200, 200, 200, 200×324+429×176).
- Worker contract tests: 8/8 pass (Test 8 covers all four binding-state
  cases: success, denied, missing, throwing).
- Safety net: 573 unit + 8 worker + dry-run + 87 browser = 668 / 668 pass.

## References

- ADR 0018 — Multi-origin CORS allowlist + public `config.js` (the
  predecessor change this one extends).
- Cloudflare Workers Rate Limiting binding docs
  (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- `scripts/safety-net.sh` — pre-commit gate the rate-limit code lands
  through.
