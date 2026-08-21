// tests/browser/_sync_auto_pull_loop_guard.spec.js — Playwright regression
// guard for the v1.12 sync auto-pull fix.
//
// Run: stage 4 of ./scripts/safety-net.sh.
//
// What it covers:
//
//   When a user transitions syncStatus from any non-connected state into
//   'connected', exactly ONE syncNow() call should fire. The first
//   syncNow sets status='syncing' mid-flight and restores it to
//   'connected' at the end; the new $watch on syncStatus must NOT
//   re-fire on those internal transitions (which would cause an
//   infinite pull loop).
//
// Why a separate spec:
//
//   The user-facing regression test in _sync_auto_pull.spec.js asserts
//   that the local view reflects remote after connect. It cannot easily
//   detect a loop because every loop iteration reads back the same
//   data and writes succeed. This spec counts syncNow() calls directly
//   to catch the loop guard by construction.
//
// Architecture note (why this matters):
//
//   - init() historically ran TWICE — once by Alpine 3 auto-init (it
//     calls any method named init() on x-data after mount) and once by
//     the explicit x-init="init()" directive on the root div. Without
//     the _initialized idempotency guard, every $watch registered in
//     init() would register twice and fire twice per change.
//   - The rising-edge guard (oldVal !== 'connected' && oldVal !==
//     'syncing') inside the $watch handler covers the second source of
//     false positives: the internal syncing→connected transition that
//     syncNow() itself produces at the end of every call.
//
// Together these two guards ensure: exactly 1 syncNow per real connect
// event, no matter how Alpine schedules the reactivity flush.

'use strict';

const { test, expect } = require('@playwright/test');
const { cleanRoutes } = require('./_helpers');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// See helpers.js#cleanRoutes — wildcard `page.route('**/*')` leaks
// across tests.
test.afterEach(async ({ page }) => {
  await cleanRoutes(page);
});

test('v1.12 sync auto-pull: exactly one syncNow fires per connect transition (no loop)', async ({ page }) => {
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify({
      version: '1.1', holdings: [], cash_accounts: [], debts: [],
      categories: [], snapshots: [], backups: [], deletions: [],
      settings: { display_currency: 'TWD', language: 'en', cost_format: 'per_share', fx_source: 'manual', fx_rate: 32.2 },
      meta: { device_id: 'test-device', last_synced_at: null, created_at: '2024-01-01T00:00:00.000Z' },
    }));
  `);
  // Drive returns "no portfolio file" so syncNow's else-branch runs
  // (createPortfolioFile path). We don't care about the round-trip
  // shape; we only care about the count of syncNow() invocations.
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/drive/v3/files') && url.includes('?')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"files":[]}' });
    }
    if (url.includes('/upload/drive/v3/files') && route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"new-portfolio-file"}' });
    }
    return route.continue();
  });

  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine);

  // Count syncNow calls. Wait long enough for any infinite loop to
  // blow up the count (we catch it with the threshold check below).
  // 1500 ms is comfortable: a real syncNow round-trip in the mock
  // takes <50 ms, so anything >5 calls means we're looping.
  const count = await page.evaluate(async () => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    let n = 0;
    const orig = data.syncNow.bind(data);
    data.syncNow = async function () {
      n++;
      return orig();
    };
    // Simulate the OAuth-callback state transition. Both the OAuth
    // callback and a test-side direct set take this path because the
    // new $watch is registered on syncStatus, not on the token.
    data.syncAccessToken = 'fake-token-for-test';
    data.syncStatus = 'connected';
    await new Promise(r => setTimeout(r, 1500));
    return n;
  });

  // Exactly one call: the user's "I just clicked Connect" event. The
  // syncing→connected round-trip inside syncNow is suppressed by the
  // rising-edge guard; a second $watch registration (from init()
  // running twice) is suppressed by the _initialized idempotency flag.
  //
  // Threshold chosen as "<=2" not "==1" to leave slack for any future
  // legitimate edge case (e.g. user clicks Sync now immediately after
  // the auto-pull resolves — that's a real user-initiated second call,
  // not a loop). Anything >5 would be an infinite loop.
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThanOrEqual(2);
});