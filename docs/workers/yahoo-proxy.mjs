// docs/workers/yahoo-proxy.mjs — Cloudflare Worker for Yahoo Finance CORS bypass.
//
// DEPLOY:
//   1. Sign up at dash.cloudflare.com (no credit card needed).
//   2. Workers & Pages → Create application → Create Worker → name it e.g.
//      "yahoo-proxy" → click Create.
//   3. Click "Edit Code" → paste this entire file → click Save and Deploy.
//   4. Copy the URL (format: https://yahoo-proxy.YOURACCOUNT.workers.dev).
//   5. (Optional) Add environment variable ALLOWED_ORIGIN via the dashboard
//      (Settings → Variables) to lock the Worker to your app's origin.
//
// USE:
//   GET /?url=<encoded Yahoo chart URL>
//
//   Example:
//     https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FAAPL%3Finterval%3D1d%26range%3D1d
//
// FREE TIER:
//   100,000 requests/day. A personal portfolio app uses ~50 req/day
//   (10 holdings × ~5 refreshes).
//
// WHAT IT DOES:
//   - Allows browser-side fetch to Yahoo by adding CORS headers.
//   - Adds a User-Agent and consent cookie to Yahoo requests (Yahoo blocks
//     requests without these from non-browser sources).
//   - Caches the consent cookie for 24h in module scope.
//   - Restricts target URLs to query1.finance.yahoo.com (chart data) and
//     fc.yahoo.com (cookie bootstrap host) (security).
//   - Restricts origin to ALLOWED_ORIGIN env var if set (security).
//     ALLOWED_ORIGIN accepts a single origin, a comma-separated string, or a
//     TOML array (parsed uniformly here). When multiple origins are allowed
//     the response echoes the request origin per the CORS multi-origin
//     pattern; the first entry is the fallback for origin-less requests.
//     Origin-less requests (no Origin header) themselves bypass the allowlist
//     so curl smoke tests work; the Host allowlist below still restricts
//     the target URL.
//
// TESTING:
//   curl 'https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FAAPL%3Finterval%3D1d%26range%3D1d'
//
// SECURITY:
//   - Without ALLOWED_ORIGIN env var, any origin can use the Worker (uses up
//     your 100k/day quota). For personal use this is fine.
//   - With ALLOWED_ORIGIN set (e.g. to "http://localhost:8000"), only those
//     origins are allowed. Recommended for production.
//
// RATE LIMIT:
//   - Optional. If a `[[ratelimits]]` binding named RATE_LIMITER is declared
//     in wrangler.toml, the Worker enforces N requests per 60 seconds per
//     CF-Connecting-IP (configurable in wrangler.toml — adjust `limit` to
//     trade legitimate headroom against abuse-resistance). 100 req/60s is
//     the default in wrangler.toml.example.
//   - Without the binding (dev mode, or before this was added), the check is
//     a no-op.
//   - On binding failure (e.g. Cloudflare side error), the check fails OPEN
//     (allows the request). A quota-protection outage would be worse than
//     no quota protection.
//   - 429 responses still carry CORS headers so browsers surface a useful
//     error instead of an opaque CORS failure.
//
// ENDPOINT NOTE:
//   This Worker uses Yahoo's /v8/finance/chart/<SYMBOL> endpoint, NOT the
//   /v7/finance/quote batch endpoint. As of 2025, Yahoo locked the quote
//   endpoint behind crumb auth (which requires browser session bootstrapping
//   we can't replicate server-side). The chart endpoint is the same data
//   delivered to Yahoo's embed widgets and is publicly accessible with just
//   cookie + User-Agent. Per-symbol fetch (not batched).

const CHART_HOST = 'query1.finance.yahoo.com';
const COOKIE_HOST = 'fc.yahoo.com';
const ALLOWED_HOSTS = new Set([CHART_HOST, COOKIE_HOST]);
const CACHE_MS = 24 * 60 * 60 * 1000;  // 24h — Yahoo's A3 cookie expires in 1 year

// Module-scoped cache for the consent cookie. Survives across requests in
// the same Worker isolate.
let cookieCache = { value: '', expiresAt: 0 };

async function bootstrapCookie() {
  // Hit fc.yahoo.com/ to obtain the A3 consent cookie.
  // NOTE: the page returns HTTP 404 but the Set-Cookie header is still
  // sent. We only care about the cookie, so we don't check status.
  const res = await fetch(`https://${COOKIE_HOST}/`, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`cookie bootstrap failed: no Set-Cookie (HTTP ${res.status})`);
  }
  // Take only the name=value part (drop Domain, Path, Expires, etc.)
  return setCookie.split(';')[0];
}

async function getCookie() {
  if (cookieCache.value && Date.now() < cookieCache.expiresAt) return cookieCache.value;
  const value = await bootstrapCookie();
  cookieCache = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

// Parse ALLOWED_ORIGIN into a list. Accepts:
//   - null/undefined → null (permissive default, see isOriginAllowed)
//   - TOML array     → used as-is
//   - comma-separated string → split, trimmed, empty entries dropped
// A TOML array (wrangler.toml) and a comma-separated string (Cloudflare
// dashboard) both flow through this function identically.
function parseAllowedOrigins(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

function isOriginAllowed(env, origin) {
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGIN);
  if (!allowed || allowed.length === 0) return true;  // permissive default
  // Origin-less requests (server-to-server, curl smoke tests) bypass the
  // allowlist. The Host allowlist in handleRequest still restricts target
  // URLs to Yahoo's chart/cookie hosts. Browser requests without a matching
  // Origin still get 403.
  if (origin === '') return true;
  return allowed.includes(origin);
}

function corsHeaders(requestOrigin, env) {
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGIN);
  let allowOrigin = '*';
  if (allowed && allowed.length > 0) {
    // Multi-origin CORS pattern: echo the request origin when it's in the
    // allowlist. Fall back to the first allowed entry when no Origin header
    // is present (server-to-server / curl smoke tests).
    allowOrigin = (requestOrigin && allowed.includes(requestOrigin))
      ? requestOrigin
      : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

// Optional per-IP rate limit. Returns true if the request should be blocked
// with 429; false if it should proceed (either under the limit, or no
// binding configured, or binding itself errored).
//
// Wrangler declares the binding in [[ratelimits]] and provisions the
// namespace on first deploy — see wrangler.toml.example.
async function isRateLimited(request, env) {
  if (!env.RATE_LIMITER) return false;  // No binding — dev mode or pre-config
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
    return !success;
  } catch (e) {
    // Fail open on binding errors. The header comment above documents the
    // trade-off: a quota-protection outage would be worse than no quota
    // protection.
    return false;
  }
}

async function handleRequest(request, env) {
  const origin = request.headers.get('origin') || '';

  // Origin allowlist
  if (!isOriginAllowed(env, origin)) {
    return new Response('forbidden', { status: 403 });
  }

  // Per-IP rate limit (Cloudflare Workers Rate Limiting binding, optional).
  // Runs after the origin check so a denied origin can't burn through a
  // legit user's bucket via cross-origin spam. 429 carries CORS headers so
  // the browser surfaces a clean error instead of a CORS failure.
  if (await isRateLimited(request, env)) {
    return new Response('rate limited', {
      status: 429,
      headers: corsHeaders(origin, env),
    });
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin, env),
    });
  }

  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }

  // Extract target URL
  const targetParam = new URL(request.url).searchParams.get('url');
  if (!targetParam) {
    return new Response('missing ?url=', { status: 400 });
  }

  let target;
  try {
    target = new URL(targetParam);
  } catch (e) {
    return new Response('invalid url', { status: 400 });
  }

  // Domain allowlist — query1.finance.yahoo.com (chart data) and fc.yahoo.com
  // (cookie bootstrap, but also valid as a proxy target per spec)
  if (!ALLOWED_HOSTS.has(target.host)) {
    return new Response('forbidden host', { status: 403 });
  }

  // Get consent cookie (cached)
  const cookie = await getCookie();

  // Proxy with cookie + UA
  const res = await fetch(target, {
    headers: {
      cookie,
      'user-agent': 'Mozilla/5.0 (compatible; portfolio-tracker)',
      accept: 'application/json',
    },
  });

  // Build response with CORS headers
  const headers = {
    ...corsHeaders(origin, env),
    'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
  };
  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      // Per spec: cookie bootstrap failure (and any other unhandled error)
      // surfaces as 500 rather than propagating to the runtime.
      return new Response(`server error: ${e?.message ?? e}`, { status: 500 });
    }
  },
};

// Test helper — exposed so Node contract tests can reset the module-scoped
// cookie cache between tests. Not part of the runtime API surface.
export function _resetCookieCacheForTesting() {
  cookieCache = { value: '', expiresAt: 0 };
}