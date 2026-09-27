// tests/browser/backups-cloud.spec.js — Playwright browser smoke for the Backups
// page (v1.23 — ADR 0029).
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright owns
// its own test discovery under playwright.config.ts testDir).
//
// What it covers (v1.23 ticket 02 / spec §Browser smoke):
//   - List renders — 5 Cloud (Layer 2) backups visible with timestamp /
//     device / source badges. The Local section is removed in v1.23.
//   - Restore applies — confirm dialog accepted; holdings reflect the
//     backup's state; toast visible. v1.23 removes the pre-restore
//     self-protection push, so the toast no longer mentions saving
//     the current state as a new backup.
//
// Wiring notes:
//   - Portfolio fixture is injected via page.addInitScript() into
//     localStorage under STORAGE_KEY (same as refresh.spec.js).
//   - Drive API calls are intercepted at `page.route` for the Drive
//     host (page hosts: `www.googleapis.com`). Layer 2 reads are mocked
//     to return canned JSON; writes/DELETEs are acknowledged.
//   - window.confirm is auto-accepted via page.on('dialog', d => d.accept()).
//   - Cloud-only fixture: `makeFixture({ cloudCount, currentShares })`
//     constructs a portfolio with no `data.backups` (Layer 1 is
//     removed); the cloud backup files are constructed from
//     `makeCloudBackupFiles(n)`. The Local (Layer 1) builders
//     (`makeBackupEntry`, `makeFixture({ localCount })`) are gone.

'use strict';

const { test, expect } = require('@playwright/test');
const { cleanRoutes } = require('./_helpers');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// One Cloud backup's payload (the prior state we restore FROM in the
// restore tests). The current fixture has 10 shares; the cloud backup
// has 5 shares — so the restore is observable in the holdings table.
const PRIOR_STATE = {
  holdings: [{ id: 'h-prior', ticker: 'AAPL', shares: 5, cost: 100, currency: 'TWD', current_price: 0, attributes: {} }],
  cash_accounts: [],
  debts: [],
  backups: [],
  deletions: [],
  meta: { device_id: 'smoke-test-device', last_synced_at: null, created_at: '2024-06-01T00:00:00.000Z' },
  settings: { display_currency: 'TWD', language: 'en', cost_format: 'per_share', fx_source: 'manual', fx_rate: 32.2 },
};

// Cloud-only fixture (v1.23). `data.backups` is omitted because
// v1.23's wire format is `backups: []` and the migration clears any
// pre-existing entries on load. The cloud backup files are sourced
// from `makeCloudBackupFiles` (no Layer 1 `makeBackupEntry` helper).
function makeFixture({ cloudCount = 5, currentShares = 10 } = {}) {
  return {
    version: '1.1',
    holdings: [{
      id: 'h-current',
      ticker: 'AAPL',
      shares: currentShares,
      cost: 100,
      currency: 'TWD',
      current_price: 0,
      attributes: {},
    }],
    cash_accounts: [],
    debts: [],
    categories: [],
    snapshots: [],
    backups: [], // v1.23 — always [] on the wire (ADR 0029 §1)
    deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
    },
    meta: {
      device_id: 'smoke-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

// N Cloud (Layer 2) backup files. Filename follows the lib contract
// `portfolio-backup-{deviceId}-{ISO}.json`. modifiedTime drives the row's
// timestamp display.
function makeCloudBackupFiles(n = 5, devicePrefix = 'web-other') {
  const files = [];
  for (let i = 0; i < n; i++) {
    const iso = new Date(Date.parse('2024-06-01T00:00:00.000Z') + i * 86400000).toISOString();
    files.push({
      id: `cloud-${i + 1}`,
      name: `portfolio-backup-${devicePrefix}-${iso}.json`,
      modifiedTime: iso,
    });
  }
  return files;
}

// Page hosts we intercept. Drive list reads, Drive content reads, Drive
// writes, and Drive DELETEs all go through www.googleapis.com.
const HOSTS = ['www.googleapis.com'];

// Initial script: seed localStorage with the fixture before page scripts run.
function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
  `;
}

function collectAppErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => {
    // Tolerate Alpine 3.13.3 internal x-show transition race
    // (alpinejs/src/directives/x-show.js:1070). When an x-show bound
    // element's reactive scope flips truthy at the wrong moment,
    // _x_hidePromise is undefined when the recursive hideAfterChildren
    // chain expects it to be a function, and `Promise.all([undefined,
    // ...]).then(([i]) => i())` calls `undefined()` — minified to
    // "u is not a function". This is upstream Alpine behaviour,
    // unrelated to portfolio.html. See test "list renders" which
    // sets syncAccessToken after navigation and occasionally hits
    // this race.
    if (/u is not a function/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource/i.test(text)) {
      // Tolerate favicon 404s and any 4xx/5xx (the message itself
      // includes the status code; we don't care about the URL because
      // the test body verifies the actual response).
      if (/favicon\.ico$/i.test(msg.location()?.url || '')) return;
      if (/status of [45][0-9]{2}/i.test(text)) return;
    }
    if (/tailwind|alpine\.js|googleapis\.com|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

test.describe('portfolio.html backups page (v1.23 — ADR 0029)', () => {
  // See helpers.js#cleanRoutes — wildcard `page.route('**/*')` leaks
  // across tests and produces a "Resulting promise was garbage
  // collected" race in the next test's fetchCloudBackups() call.
  test.afterEach(async ({ page }) => {
    await cleanRoutes(page);
  });

  // Defense in depth: if the browser context is somehow reused across
  // tests (Playwright context collapse is a known intermittent),
  // localStorage / sessionStorage / cookies from the previous test
  // would leak. Clearing them in beforeEach guarantees the page
  // starts with the in-memory fixture only.
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await page.evaluate(() => {
      try { localStorage.clear(); } catch (_) { /* pre-navigation */ }
      try { sessionStorage.clear(); } catch (_) { /* pre-navigation */ }
    });
  });

  test('list renders: 5 Cloud backups visible with timestamp + device + source', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture({ cloudCount: 5 });
    const cloudFiles = makeCloudBackupFiles(5);

    await page.addInitScript(initScript(fixture));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();
      if (url.includes('/drive/v3/files?') && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: cloudFiles }),
        });
      }
      if (url.includes('/upload/drive/v3/files') && req.method() === 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"new"}' });
      }
      // Find-portfolio-file (the page may check it on load).
      if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [{ id: 'portfolio-file-id', name: 'property_tracker_portfolio_v1.json', modifiedTime: '2024-07-01T00:00:00.000Z' }] }),
        });
      }
      return route.continue();
    });

    await page.goto('http://localhost:8000/portfolio.html');

    // Click Backups nav button.
    await page.locator('button:has-text("Backups")').click();

    // Page heading visible.
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    // The user hasn't signed in to Drive in this scenario, so the
    // fetchCloudBackups() bail-out path runs by default — set a fake
    // token via Alpine's reactive scope so the page actually queries
    // Drive and shows the mocked cloud backups.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      // Alpine exposes the reactive scope via Alpine.$data(root).
      const data = window.Alpine?.$data?.(root);
      if (!data) throw new Error('Alpine.$data is not available');
      data.syncAccessToken = 'fake-token-for-test';
    });
    // Trigger a re-fetch (invalidate the cache so fetchCloudBackups
    // doesn't bail on cache.loaded === true). The cache is exposed
    // on _backupCache after the 0f5348d refactor that moved the
    // state machine into lib/backup.js.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      // Defensive: init() may run slightly after the page is
      // navigable; if _backupCache isn't ready yet, wait one tick.
      if (!data._backupCache) {
        return new Promise((resolve) => {
          const i = setInterval(() => {
            if (data._backupCache) {
              clearInterval(i);
              data._backupCache.clear();
              resolve(data.fetchCloudBackups());
            }
          }, 10);
          setTimeout(() => { clearInterval(i); resolve(null); }, 1000);
        });
      }
      data._backupCache.clear();
      return data.fetchCloudBackups();
    });

    // Cloud sub-list renders 5 rows.
    const cloudRows = page.locator('[data-testid="cloud-backups"] [data-testid="backup-row"]');
    await expect(cloudRows).toHaveCount(5, { timeout: 10_000 });

    // Each row has timestamp + device badge + source badge + Restore button.
    for (const row of await cloudRows.all()) {
      await expect(row.locator('[data-testid="backup-timestamp"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-device"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-source"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-restore-btn"]')).toBeVisible();
    }

    // v1.23 — the Local section is removed; data-testid="local-backups"
    // must NOT be present in the DOM (the testid selector fails fast).
    await expect(page.locator('[data-testid="local-backups"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('restore applies: confirm dialog accepted; holdings reflect backup state; toast visible', async ({ page }) => {
    const errors = collectAppErrors(page);
    // One cloud backup file whose content is PRIOR_STATE (5 shares);
    // current state has 10 shares. The restore reads the cloud file
    // content via readPortfolioBackupFile and applies it.
    const fixture = makeFixture({ currentShares: 10 });
    const cloudFiles = makeCloudBackupFiles(1);
    // The first (and only) cloud file id is what readPortfolioBackupFile
    // will fetch. Its content returns PRIOR_STATE.

    await page.addInitScript(initScript(fixture));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();
      if (/\/drive\/v3\/files\?/.test(url) && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: cloudFiles }),
        });
      }
      if (/\/upload\/drive\/v3\/files/.test(url) && req.method() === 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"new"}' });
      }
      if (/\/drive\/v3\/files\/[^/?]+/.test(url) && (req.method() === 'PATCH' || req.method() === 'DELETE' || req.method() === 'GET')) {
        if (req.method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: req.method() === 'GET' ? JSON.stringify(PRIOR_STATE) : '{}' });
      }
      if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [{ id: 'portfolio-file-id', name: 'property_tracker_portfolio_v1.json', modifiedTime: '2024-07-01T00:00:00.000Z' }] }),
        });
      }
      return route.continue();
    });

    // Auto-accept all dialogs (window.confirm).
    page.on('dialog', async (dialog) => {
      // Verify the confirm message has expected fields (timestamp + device).
      const msg = dialog.message();
      expect(msg).toMatch(/replace your current portfolio/i);
      expect(msg).toMatch(/by\s+\S+/);
      await dialog.accept();
    });

    await page.goto('http://localhost:8000/portfolio.html');

    // The user hasn't connected to Drive by default (syncAccessToken is
    // null). driveFetch throws "Not connected to Google Drive" if we
    // try to writePortfolioFile. Inject a fake token so the restore
    // flow can complete end-to-end.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.syncAccessToken = 'fake-token-for-test';
    });

    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    // Single backup row visible (the one cloud file).
    await expect(page.locator('[data-testid="backup-row"]')).toHaveCount(1, { timeout: 10_000 });

    // Click Restore.
    await page.locator('[data-testid="backup-restore-btn"]').first().click();

    // Wait for toast to appear.
    const toast = page.locator('[data-testid="restore-toast"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/Restored from/i);
    // v1.23 (ADR 0029): toast no longer mentions "current state was saved
    // as a new backup" — Layer 1 self-protection is removed.
    await expect(toast).not.toContainText(/current state was saved as a new backup/i);

    // Navigate to Holdings and confirm the holding's shares are now 5 (the backup's state).
    await page.locator('button:has-text("Holdings")').click();
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });
    // The shares column should now show 5 (the backup's value), not 10 (the initial fixture).
    await expect(page.locator('tr:has-text("AAPL") td:text("5")')).toBeVisible();

    expect(errors).toEqual([]);
  });
});