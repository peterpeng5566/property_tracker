// tests/browser/_sync_auto_pull.spec.js — Playwright browser smoke for v1.12
// sync auto-pull. REGRESSION TEST for the user-reported bug:
//
//   "在手机 update 后，也 sync 到 cloud，之后用电脑开，连到 cloud 并不会
//    自动更新 cloud 最新的 data 下来，需要手动从 backup restore"
//
// Run: stage 4 of ./scripts/safety-net.sh.
//
// What it covers:
//
//   - Connect to Google Drive triggers an automatic pull + merge so the
//     local view reflects the cloud's newer state, without requiring the
//     user to click the "Sync now" button.
//
// Why this matters:
//   The README + ADR 0002 promise "pull-on-open, push-on-save". Only the
//   push half is implemented; the pull half is missing. The fix is to
//   call syncNow() after the OAuth callback sets syncStatus='connected'
//   (or, if a stored token is still valid, after init() recognises it).
//
// Approach:
//   - Seed localStorage with stale local data (older timestamps, fewer
//     shares — simulates "desktop last opened 3 days ago").
//   - Mock Google Drive to return newer remote data (mobile's recent
//     edit, with a fresher updated_at + larger shares).
//   - Load the page (init() runs, reads local stale data).
//   - Bypass the OAuth round-trip by setting syncAccessToken +
//     syncStatus='connected' directly via Alpine.$data. This simulates
//     the state immediately after the OAuth callback in
//     `portfolio.html:3619`.
//   - Wait a tick for the (expected) auto-pull to fire.
//   - Assert: data.holdings[0].shares reflects the mobile's value
//     (1000, not 100). RED before the fix; GREEN after.
//
// Why drive Alpine directly instead of clicking through the UI:
//   We are testing the post-connect pull, not the OAuth flow itself.
//   The existing v17-sync.spec.js follows the same convention (calls
//   window.Sync.mergePortfolios directly to assert merge primitives
//   without re-implementing OAuth in the browser).
//
// What this test does NOT cover (out of scope for v1.12):
//   - The OAuth popup itself (covered by Google's own GSI library).
//   - The auto-push behaviour after a save (already covered by
//     scheduleAutoPush's existing flow).
//   - Token expiry / refresh (separate concern, separate ticket).
//
// Test files in tests/browser/_*.spec.js are framework-y / cross-cutting
// smoke tests. They run in stage 4 of the safety net alongside the rest.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Local state: stale — "3 days ago on desktop, before mobile edited".
// shares = 100, updated_at is older.
function makeLocalFixture() {
  return {
    version: '1.1',
    holdings: [{
      id: 'h-1', ticker: '2330.TW',
      shares: 100, cost: 50,
      currency: 'TWD', current_price: 600,
      updated_at: '2024-07-01T00:00:00.000Z',
      device_id: 'desktop-stale',
      attributes: {},
    }],
    cash_accounts: [],
    debts: [],
    categories: [],
    snapshots: [],
    backups: [],
    deletions: [],
    settings: { display_currency: 'TWD', language: 'en', cost_format: 'per_share', fx_source: 'manual', fx_rate: 32.2, updated_at: '2024-07-01T00:00:00.000Z', device_id: 'desktop-stale' },
    meta: { device_id: 'desktop-stale', last_synced_at: null, created_at: '2024-06-01T00:00:00.000Z' },
  };
}

// Remote state: mobile's push — newer timestamp, larger shares.
function makeRemoteFixture() {
  return {
    version: '1.1',
    holdings: [{
      id: 'h-1', ticker: '2330.TW',
      shares: 1000, cost: 50,           // ← mobile edited shares
      currency: 'TWD', current_price: 600,
      updated_at: '2024-07-04T00:00:00.000Z',  // ← 3 days newer
      device_id: 'mobile-fresh',
      attributes: {},
    }],
    cash_accounts: [],
    debts: [],
    categories: [],
    snapshots: [],
    backups: [],
    deletions: [],
    settings: { display_currency: 'TWD', language: 'en', cost_format: 'per_share', fx_source: 'manual', fx_rate: 32.2, updated_at: '2024-07-04T00:00:00.000Z', device_id: 'mobile-fresh' },
    meta: { device_id: 'mobile-fresh', last_synced_at: '2024-07-04T00:00:00.000Z', created_at: '2024-06-01T00:00:00.000Z' },
  };
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
  `;
}

// Mirror the backups.spec.js error-collection discipline: tolerate
// favicon 404s, CDN noise, GSI script not loaded in offline test,
// Alpine 3.13.3 x-show transition race (`u is not a function`).
function collectAppErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => {
    if (/u is not a function/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource/i.test(text)) {
      if (/favicon\.ico$/i.test(msg.location()?.url || '')) return;
      if (/status of [45][0-9]{2}/i.test(text)) return;
    }
    if (/tailwind|alpine\.js|googleapis\.com|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

test.describe('v1.12 sync auto-pull (regression for "open on second device does not pull latest")', () => {
  test('connect to Drive triggers auto-pull — local view reflects remote\'s newer state', async ({ page }) => {
    const errors = collectAppErrors(page);
    const localFixture = makeLocalFixture();
    const remoteFixture = makeRemoteFixture();

    await page.addInitScript(initScript(localFixture));
    // Mock Google Drive so a pull returns the remote (mobile) state.
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();

      // Find-portfolio-file: the sync flow's first Drive call.
      // Mirrors backups.spec.js's pattern.
      if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [{
            id: 'portfolio-file-id',
            name: 'property_tracker_portfolio_v1.json',
            modifiedTime: '2024-07-04T00:00:00.000Z',
          }] }),
        });
      }
      // Read-portfolio-file: alt=media URL.
      if (/\/drive\/v3\/files\/[^?]+\?alt=media/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(remoteFixture),
        });
      }
      // Write-portfolio-file: the sync flow's push step.
      if (url.includes('/upload/drive/v3/files') && req.method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"id":"portfolio-file-id"}',
        });
      }
      return route.continue();
    });

    await page.goto('http://localhost:8000/portfolio.html');
    await page.waitForFunction(() => !!window.Alpine && !!document.querySelector('[x-data]'));

    // Sanity: page loaded the stale local data (100 shares).
    const beforeConnect = await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      return {
        shares: data.data.holdings[0].shares,
        updated_at: data.data.holdings[0].updated_at,
      };
    });
    expect(beforeConnect.shares).toBe(100);

    // Simulate the OAuth callback in `portfolio.html:3619`:
    //   callback sets syncAccessToken + syncStatus='connected'.
    // We bypass the actual OAuth popup (out of scope) and drive the
    // post-auth state directly. After the fix, this should trigger
    // an auto-pull that overwrites local stale data with remote data.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.syncAccessToken = 'fake-token-for-test';
      data.syncStatus = 'connected';
    });

    // Wait long enough for any auto-pull to round-trip through Drive.
    // 1500 ms is comfortable (Drive round-trip < 200 ms in the mock;
    // the lib merge is synchronous). Real-world latency on a slow
    // network is ~500 ms; we give 1.5× margin.
    await page.waitForTimeout(1500);

    // Assertion: local view should now reflect remote's mobile edit
    // (shares = 1000, updated_at = 2024-07-04).
    //
    // RED before the fix: shares stays at 100 (no auto-pull exists),
    // updated_at stays at 2024-07-01.
    //
    // GREEN after the fix: shares = 1000, updated_at = 2024-07-04.
    const afterAutoPull = await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      return {
        shares: data.data.holdings[0].shares,
        updated_at: data.data.holdings[0].updated_at,
        device_id: data.data.holdings[0].device_id,
        last_synced_at: data.data.meta?.last_synced_at || null,
      };
    });

    expect(afterAutoPull.shares).toBe(1000);
    expect(afterAutoPull.updated_at).toBe('2024-07-04T00:00:00.000Z');
    expect(afterAutoPull.device_id).toBe('mobile-fresh');
    expect(afterAutoPull.last_synced_at).not.toBeNull();

    expect(errors).toEqual([]);
  });
});