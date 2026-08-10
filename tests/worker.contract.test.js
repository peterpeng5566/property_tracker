// tests/worker.contract.test.js — Cloudflare Worker contract tests (Node, no jsdom).
//
// Run: stage 2 of ./scripts/safety-net.sh ONLY — NOT ./test.sh. The file
// mocks globalThis.fetch per test, which differs from the zero-mock style
// of lib/*.test.js; keeping the file out of ./test.sh avoids cross-test
// pollution via globalThis.fetch between the two suites.
//
// Module loading: the Worker is imported dynamically. The file is .mjs (so
// Node treats it as ESM) and we resolve its absolute path and convert to a
// file:// URL for the dynamic import.
//
// Test cases (7 total, in the order specified by ticket 02):
//   1. 200 OK response forwarding with full body intact
//   2. OPTIONS preflight returns 204 with CORS headers
//   3. Origin allowlist: allowed, denied, unset (default '*')
//   4. Host allowlist: query1.finance.yahoo.com ✓, fc.yahoo.com ✓, others ✗
//   5. Missing ?url= returns 400
//   6. Cookie bootstrap failure (fetch rejects) returns 500
//   7. Cookie cache hit on second request — fc.yahoo.com fetched exactly once

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

const WORKER_URL = pathToFileURL(
  resolve(__dirname, '../docs/workers/yahoo-proxy.mjs')
).href;

let worker;
let resetCache;
let originalFetch;

before(async () => {
  const mod = await import(WORKER_URL);
  worker = mod.default;
  resetCache = mod._resetCookieCacheForTesting;
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// ===== Test helpers =====

// Build a Request with the worker's URL shape and a controllable origin.
function makeRequest(url, { method = 'GET', origin = 'http://localhost:8000' } = {}) {
  return new Request(url, {
    method,
    headers: { origin },
  });
}

// Install a fetch mock keyed by URL string. Returns a spy with a `count(url)`
// helper so tests can assert how many times a URL was fetched.
function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, opts });
    const handler = handlers[urlStr];
    if (!handler) {
      throw new Error(`mock fetch: no handler for ${urlStr}`);
    }
    return typeof handler === 'function' ? handler(url, opts) : handler;
  };
  return {
    calls,
    count: (substr) => calls.filter((c) => c.url.includes(substr)).length,
  };
}

// Standard chart URL used by most tests.
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL';
const PROXY_BASE = 'https://yahoo-proxy.example.workers.dev';
const COOKIE_OK = () =>
  new Response(null, { headers: { 'set-cookie': 'A1=dummy; Path=/' } });
const CHART_OK = (body = '{"chart":{"result":[]}}') =>
  new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

// ===== Test 1: 200 OK response forwarding with full body intact =====
test('worker: forwards 200 OK with full body and Content-Type', async () => {
  resetCache();
  const body = '{"chart":{"result":[{"meta":{"symbol":"AAPL","regularMarketPrice":225.5}}]}}';
  mockFetch({
    'https://fc.yahoo.com/': COOKIE_OK(),
    [CHART_URL]: CHART_OK(body),
  });

  const req = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`);
  const res = await worker.fetch(req, { ALLOWED_ORIGIN: 'http://localhost:8000' });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
});

// ===== Test 2: OPTIONS preflight returns 204 with CORS headers =====
test('worker: OPTIONS preflight returns 204 with CORS headers', async () => {
  resetCache();
  // Preflight must not trigger any fetch — if it does, the mock will throw.
  globalThis.fetch = async () => {
    throw new Error('preflight should not call fetch');
  };

  const req = makeRequest(`${PROXY_BASE}/`, { method: 'OPTIONS' });
  const res = await worker.fetch(req, { ALLOWED_ORIGIN: 'http://localhost:8000' });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), '*');
});

// ===== Test 3: Origin allowlist =====
test('worker: origin allowlist — allowed, denied, unset (default *)', async () => {
  resetCache();
  mockFetch({
    'https://fc.yahoo.com/': COOKIE_OK(),
    [CHART_URL]: CHART_OK(),
  });

  // 3a. Allowed origin → 200
  const req1 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`, {
    origin: 'http://localhost:8000',
  });
  const res1 = await worker.fetch(req1, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res1.status, 200);

  // 3b. Denied origin → 403
  const req2 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`, {
    origin: 'http://evil.example',
  });
  const res2 = await worker.fetch(req2, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res2.status, 403);

  // 3c. Unset ALLOWED_ORIGIN → defaults to '*', any origin allowed
  const req3 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`, {
    origin: 'http://anything.example',
  });
  const res3 = await worker.fetch(req3, {});
  assert.equal(res3.status, 200);
  assert.equal(res3.headers.get('Access-Control-Allow-Origin'), '*');
});

// ===== Test 4: Host allowlist =====
test('worker: host allowlist — query1 + fc.yahoo.com allowed, others denied', async () => {
  resetCache();
  mockFetch({
    'https://fc.yahoo.com/': COOKIE_OK(),
    'https://fc.yahoo.com/some/path': CHART_OK(),
    [CHART_URL]: CHART_OK(),
  });

  // 4a. query1.finance.yahoo.com → 200
  const req1 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`);
  const res1 = await worker.fetch(req1, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res1.status, 200);

  // 4b. fc.yahoo.com → 200 (allowed per spec)
  const fcUrl = 'https://fc.yahoo.com/some/path';
  const req2 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(fcUrl)}`);
  const res2 = await worker.fetch(req2, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res2.status, 200);

  // 4c. example.com → 403
  const exUrl = 'https://example.com/';
  const req3 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(exUrl)}`);
  const res3 = await worker.fetch(req3, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res3.status, 403);
});

// ===== Test 5: Missing ?url= returns 400 =====
test('worker: missing ?url= returns 400', async () => {
  resetCache();
  globalThis.fetch = async () => {
    throw new Error('missing-?url= path should not call fetch');
  };

  const req = makeRequest(`${PROXY_BASE}/`);
  const res = await worker.fetch(req, { ALLOWED_ORIGIN: 'http://localhost:8000' });

  assert.equal(res.status, 400);
});

// ===== Test 6: Cookie bootstrap failure returns 500 =====
test('worker: cookie bootstrap failure returns 500', async () => {
  resetCache();
  globalThis.fetch = async () => {
    throw new Error('cookie bootstrap failed: no Set-Cookie');
  };

  const req = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`);
  const res = await worker.fetch(req, { ALLOWED_ORIGIN: 'http://localhost:8000' });

  assert.equal(res.status, 500);
});

// ===== Test 7: Cookie cache hit on second request =====
test('worker: cookie cache hit — fc.yahoo.com fetched exactly once across two requests', async () => {
  resetCache();
  let fcFetches = 0;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr === 'https://fc.yahoo.com/') {
      fcFetches++;
      return COOKIE_OK();
    }
    if (urlStr.startsWith('https://query1.finance.yahoo.com/')) {
      return CHART_OK();
    }
    throw new Error(`mock fetch: no handler for ${urlStr}`);
  };

  // First request — bootstrap
  const req1 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`);
  const res1 = await worker.fetch(req1, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res1.status, 200);

  // Second request — cache hit
  const req2 = makeRequest(`${PROXY_BASE}/?url=${encodeURIComponent(CHART_URL)}`);
  const res2 = await worker.fetch(req2, { ALLOWED_ORIGIN: 'http://localhost:8000' });
  assert.equal(res2.status, 200);

  assert.equal(fcFetches, 1, 'fc.yahoo.com should be fetched exactly once across two requests');
});
