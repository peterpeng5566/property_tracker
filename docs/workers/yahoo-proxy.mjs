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
//
// TESTING:
//   curl 'https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FAAPL%3Finterval%3D1d%26range%3D1d'
//
// SECURITY:
//   - Without ALLOWED_ORIGIN env var, any origin can use the Worker (uses up
//     your 100k/day quota). For personal use this is fine.
//   - With ALLOWED_ORIGIN set (e.g. to "http://localhost:8000"), only that
//     origin is allowed. Recommended for production.
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

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

function isOriginAllowed(env, origin) {
  if (!env.ALLOWED_ORIGIN) return true;  // permissive default
  return origin === env.ALLOWED_ORIGIN;
}

async function handleRequest(request, env) {
  const origin = request.headers.get('origin') || '';

  // Origin allowlist
  if (!isOriginAllowed(env, origin)) {
    return new Response('forbidden', { status: 403 });
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(env),
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
    ...corsHeaders(env),
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