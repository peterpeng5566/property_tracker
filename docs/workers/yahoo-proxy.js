// docs/workers/yahoo-proxy.js — Cloudflare Worker for Yahoo Finance CORS bypass.
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
//   GET /?url=<encoded Yahoo URL>
//
//   Example:
//     https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv7%2Ffinance%2Fquote%3Fsymbols%3DAAPL
//
// FREE TIER:
//   100,000 requests/day. A personal portfolio app uses ~10 req/day.
//
// WHAT IT DOES:
//   - Allows browser-side fetch to Yahoo by adding CORS headers.
//   - Manages Yahoo cookie + crumb auth server-side (cookie jar in module scope).
//   - Caches crumb for 30 min; refreshes on auth failure.
//   - Restricts target URLs to Yahoo hosts only (security).
//   - Restricts origin to ALLOWED_ORIGIN env var if set (security).
//
// TESTING:
//   curl 'https://yahoo-proxy.YOURACCOUNT.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv7%2Ffinance%2Fquote%3Fsymbols%3DAAPL'
//
// SECURITY:
//   - Without ALLOWED_ORIGIN env var, any origin can use the Worker (uses up
//     your 100k/day quota). For personal use this is fine.
//   - With ALLOWED_ORIGIN set (e.g. to "http://localhost:8000"), only that
//     origin is allowed. Recommended for production.

const YAHOO_HOST = 'query1.finance.yahoo.com';
const COOKIE_HOST = 'fc.yahoo.com';
const CACHE_MS = 30 * 60 * 1000;  // 30 minutes

// Module-scoped cache for Yahoo crumb + cookie. Survives across requests in
// the same Worker isolate.
let cache = { cookie: null, crumb: null, expiresAt: 0 };

async function bootstrapCrumb() {
  // Step 1: hit fc.yahoo.com to obtain the consent cookie.
  const cookieRes = await fetch(`https://${COOKIE_HOST}/`, { redirect: 'manual' });
  if (!cookieRes.ok) {
    throw new Error(`cookie bootstrap failed: HTTP ${cookieRes.status}`);
  }
  const setCookie = cookieRes.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : '';

  // Step 2: fetch crumb using the cookie.
  const crumbRes = await fetch(`https://${YAHOO_HOST}/v1/test/getcrumb`, {
    headers: { cookie },
  });
  if (!crumbRes.ok) {
    throw new Error(`crumb bootstrap failed: HTTP ${crumbRes.status}`);
  }
  const crumb = (await crumbRes.text()).trim();
  if (!crumb) {
    throw new Error('crumb bootstrap failed: empty crumb');
  }
  return { cookie, crumb };
}

async function getCrumb() {
  if (cache.crumb && Date.now() < cache.expiresAt) return cache;
  cache = { ...(await bootstrapCrumb()), expiresAt: Date.now() + CACHE_MS };
  return cache;
}

function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN ?? '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

function isOriginAllowed(env, origin) {
  if (!env.ALLOWED_ORIGIN) return true;  // permissive default
  return origin === env.ALLOWED_ORIGIN;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');

    // Origin allowlist
    if (!isOriginAllowed(env, origin)) {
      return new Response('forbidden', { status: 403 });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env, origin),
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

    // Domain allowlist — only Yahoo hosts
    if (target.host !== YAHOO_HOST && target.host !== COOKIE_HOST) {
      return new Response('forbidden host', { status: 403 });
    }

    // Get crumb (cached for 30 min)
    let { cookie, crumb } = await getCrumb();
    target.searchParams.set('crumb', crumb);

    // Proxy
    let res = await fetch(target, { headers: { cookie } });

    // Retry once on auth failure (crumb may have expired)
    if (res.status === 401 || res.status === 403) {
      const fresh = await bootstrapCrumb();
      cache = { ...fresh, expiresAt: Date.now() + CACHE_MS };
      cookie = fresh.cookie;
      target.searchParams.set('crumb', fresh.crumb);
      res = await fetch(target, { headers: { cookie } });
    }

    // Build response with CORS headers
    const headers = {
      ...corsHeaders(env, origin),
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
    };
    return new Response(res.body, {
      status: res.status,
      headers,
    });
  },
};
