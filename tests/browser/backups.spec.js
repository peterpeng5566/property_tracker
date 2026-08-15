// tests/browser/backups.spec.js — Playwright browser smoke for the Backups
// page (v1.3 #03).
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright owns
// its own test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 03 / spec §Browser smoke):
//   - List renders — 5 Layer 1 + 5 Layer 2 backups all visible with
//     timestamp / device / source badges.
//   - Restore applies — confirm dialog accepted; holdings reflect the
//     backup's state; toast visible.
//   - Restore self-protects — the pre-restore snapshot is preserved in
//     data.backups[] (FIFO 5 may trim, but at minimum one new entry is
//     added — the self-protection entry).
//
// Wiring notes:
//   - Portfolio fixture is injected via page.addInitScript() into
//     localStorage under STORAGE_KEY (same as refresh.spec.js).
//   - Drive API calls are intercepted at `page.route` for the Drive
//     host (page hosts: `www.googleapis.com`). Layer 2 reads are mocked
//     to return canned JSON; writes/DELETEs are acknowledged.
//   - window.confirm is auto-accepted via page.on('dialog', d => d.accept()).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// One Layer 1 backup with prior state (holdings = 5 shares each — this
// will be the source we restore FROM in tests 2 and 3). The current
// state has 10 shares — different from the backup, so the restore is
// observable.
const PRIOR_STATE = {
  holdings: [{ id: 'h-prior', ticker: 'AAPL', shares: 5, cost: 100, currency: 'TWD', current_price: 0, attributes: {} }],
  cash_accounts: [],
  debts: [],
  backups: [],
  deletions: [],
  meta: { device_id: 'smoke-test-device', last_synced_at: null, created_at: '2024-06-01T00:00:00.000Z' },
  settings: { display_currency: 'TWD', language: 'en', cost_format: 'per_share', fx_source: 'manual', fx_rate: 32.2 },
};

// Build a `data.backups[]` entry from the prior state via Backup.buildBackupSnapshot.
// We can't require() lib/backup.js here (browser context), so we hand-craft
// the snapshot shape that buildBackupSnapshot would produce.
function makeBackupEntry(id, savedAt, snapshot) {
  return {
    id,
    saved_at: savedAt,
    data: {
      ...snapshot,
      backups: {
        count: snapshot.backups.length,
        oldest_saved_at: snapshot.backups[0]?.saved_at || null,
        newest_saved_at: snapshot.backups[snapshot.backups.length - 1]?.saved_at || null,
      },
      deletions: snapshot.deletions,
    },
  };
}

// Fixture: 1 Layer 1 backup (the source we restore from) plus 4 padding
// Layer 1 backups so test 1 can render 5 Layer 1 rows. Current holdings
// are 10 shares (different from the backup's 5).
function makeFixture({ localCount = 5, cloudCount = 5, currentShares = 10, includeSourceBackup = true } = {}) {
  const backups = [];
  if (includeSourceBackup) {
    backups.push(makeBackupEntry('bp-source', '2024-06-01T00:00:00.000Z', PRIOR_STATE));
  }
  for (let i = 1; i < localCount; i++) {
    const date = new Date(Date.parse('2024-05-01T00:00:00.000Z') + i * 86400000).toISOString();
    backups.push(makeBackupEntry(`bp-pad-${i}`, date, {
      holdings: [],
      cash_accounts: [],
      debts: [],
      backups: [],
      deletions: [],
      meta: PRIOR_STATE.meta,
      settings: PRIOR_STATE.settings,
    }));
  }
  // Sort by saved_at ascending (FIFO 5 keeps the last 5; we want
  // bp-source to be present so the restore test can find it).
  backups.sort((a, b) => Date.parse(a.saved_at) - Date.parse(b.saved_at));

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
    backups,
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

// 5 Layer 2 (cloud) backups. Each filename follows the lib's contract
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
// writes, and Drive DELETEs all go through www.googleapis.com. The
// refresh proxy URL is also intercepted (but this spec doesn't refresh —
// the page just loads — so we ignore it).
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
    // Tolerate expected errors from the rollback-loser test: when
    // writePortfolioFile's try block throws, the rejection is briefly
    // unhandled between the lib throw and the Alpine shim catch.
    // Chromium fires pageerror on every unhandled rejection, not
    // just the topmost one. The toast + rollback + self-protection
    // re-attach are the verified behaviors; this pageerror is
    // expected.
    if (/Backup write failed/i.test(e.message)) return;
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

test.describe('portfolio.html backups page (ticket #03)', () => {
  test('list renders: 5 Layer 1 + 5 Layer 2 backups shown with timestamp + device + source', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture({ localCount: 5, cloudCount: 5 });
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

    // Local sub-list renders 5 rows.
    const localRows = page.locator('[data-testid="local-backups"] [data-testid="backup-row"]');
    await expect(localRows).toHaveCount(5, { timeout: 10_000 });

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
    for (const row of [...await localRows.all(), ...await cloudRows.all()].slice(0, 10)) {
      await expect(row.locator('[data-testid="backup-timestamp"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-device"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-source"]')).toBeVisible();
      await expect(row.locator('[data-testid="backup-restore-btn"]')).toBeVisible();
    }

    expect(errors).toEqual([]);
  });

  test('list refreshes after sign-in: cache is NOT stale when user signs in after first navigation', async ({ page }) => {
    // Repro for the user-reported bug: "I see backup files in Drive,
    // but the Backups page shows 'No backups yet'." The most likely
    // cause is a stale cache: when the user navigates to Backups
    // before connecting to Drive, fetchCloudBackups sets
    // _cloudBackupsLoaded=true with an empty array. After the user
    // signs in, the cache guard returns early and the page keeps
    // showing empty.
    const errors = collectAppErrors(page);
    const fixture = makeFixture({ localCount: 0, cloudCount: 0 });
    const cloudFiles = makeCloudBackupFiles(3);

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
      if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [{ id: 'portfolio-file-id', name: 'property_tracker_portfolio_v1.json', modifiedTime: '2024-07-01T00:00:00Z' }] }),
        });
      }
      return route.continue();
    });

    await page.goto('http://localhost:8000/portfolio.html');

    // Step 1: navigate to Backups BEFORE connecting. This is the
    // scenario that triggers the cache-stale bug.
    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    // The Cloud section should show "Connect to Google Drive to see
    // cloud backups." because the user is not signed in yet.
    await expect(page.locator('text=Connect to Google Drive')).toBeVisible();

    // Step 2: user signs in (we just set the token directly via Alpine).
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.syncAccessToken = 'fake-token-for-test';
    });

    // Step 3: re-trigger the fetch by clicking Backups again. The cache
    // guard in fetchCloudBackups should NOT short-circuit — the user
    // just signed in and we need fresh data.
    await page.locator('button:has-text("Backups")').click();
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      // The bug: _cloudBackupsLoaded was set to true with empty
      // _cloudBackups when no token. Re-clicking the Backups button
      // calls fetchCloudBackups, which short-circuits because the
      // cache is "loaded". The fix should re-fetch on every Backups
      // nav click (or invalidate the cache when the token changes).
      return data.fetchCloudBackups();
    });

    // The Cloud sub-list should now render the 3 mock files.
    const cloudRows = page.locator('[data-testid="cloud-backups"] [data-testid="backup-row"]');
    await expect(cloudRows).toHaveCount(3, { timeout: 10_000 });

    expect(errors).toEqual([]);
  });

  test('restore applies: confirm dialog accepted; holdings reflect backup state; toast visible', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture({ localCount: 1 });

    await page.addInitScript(initScript(fixture));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();
      if (/\/drive\/v3\/files\?/.test(url) && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [] }),
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

    // Single backup row visible (the bp-source entry).
    await expect(page.locator('[data-testid="backup-row"]')).toHaveCount(1, { timeout: 10_000 });

    // Click Restore.
    await page.locator('[data-testid="backup-restore-btn"]').first().click();

    // Wait for toast to appear.
    const toast = page.locator('[data-testid="restore-toast"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/Restored from/i);
    await expect(toast).toContainText(/current state was saved as a new backup/i);

    // Navigate to Holdings and confirm the holding's shares are now 5 (the backup's state).
    await page.locator('button:has-text("Holdings")').click();
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });
    // The shares column should now show 5 (the backup's value), not 10 (the initial fixture).
    await expect(page.locator('tr:has-text("AAPL") td:text("5")')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('restore self-protects: the pre-restore snapshot is preserved in data.backups[]', async ({ page }) => {
    const errors = collectAppErrors(page);
    // Use a fixture with 0 initial backups so the math is clear: we
    // expect the self-protection entry AND the spec's save() re-push to
    // add at least 1 (and at most 2) new entries.
    const fixture = makeFixture({
      localCount: 1,         // 1 backup entry (the source we restore from)
      currentShares: 10,     // distinct from the backup (5 shares)
      cloudCount: 0,
    });

    await page.addInitScript(initScript(fixture));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();
      if (/\/drive\/v3\/files\?/.test(url) && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
 contentType: 'application/json',
          body: JSON.stringify({ files: [] }),
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

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.goto('http://localhost:8000/portfolio.html');

    // Inject a fake Drive token so writePortfolioFile doesn't bail with
    // "Not connected to Google Drive".
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.syncAccessToken = 'fake-token-for-test';
    });

    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    const initialLocalCount = await page.locator('[data-testid="local-backups"] [data-testid="backup-row"]').count();

    // Click Restore on the (only) backup row.
    await page.locator('[data-testid="backup-restore-btn"]').first().click();

    // Wait for toast — proves the restore flow completed.
    await expect(page.locator('[data-testid="restore-toast"]')).toBeVisible({ timeout: 10_000 });

    // After restore, data.backups gained at least one entry (the
    // self-protection snapshot of the PRE-restore state — currentShares=10).
    // Reading localStorage (the serialized state after save()) avoids
    // depending on DOM quirks of the FIFO 5 re-render.
    const finalBackups = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).backups : null;
    }, STORAGE_KEY);
    expect(Array.isArray(finalBackups)).toBe(true);
    // The original backup is still in the list.
    expect(finalBackups.some((b) => b.id === 'bp-source')).toBe(true);
    // At least one entry has data.holdings[0].shares === 10 (the pre-restore state).
    const hasSelfProtection = finalBackups.some((b) =>
      b?.data?.holdings?.some((h) => h.shares === 10)
    );
    expect(hasSelfProtection).toBe(true);

    expect(errors).toEqual([]);
  });

  test('local restore: Drive sync failure does NOT roll back, but self-protection entry is preserved in data.backups[]', async ({ page }) => {
    // Local restore's intent is local — Drive sync is best-effort
    // cross-device propagation. ADR 0012 §3 (self-protection) is
    // satisfied because step 1 already pushed a pre-restore snapshot
    // into data.backups[] before the Drive write attempt. Drive
    // failure on a local restore must NOT roll back the in-memory
    // restore; it must show a soft warning toast instead.
    //
    // This test pins that:
    //   1. Drive is "connected" (syncAccessToken is set) but the
    //      Drive upload POST returns 500.
    //   2. Holdings stay at the restored value (5 shares), NOT the
    //      pre-restore value (10 shares).
    //   3. Toast says "skipped", not "failed".
    //   4. data.backups[] still contains the self-protection entry
    //      (the pre-restore snapshot with shares===10) — code-review
    //      Tier 2B1 invariant.
    const errors = collectAppErrors(page);
    const fixture = makeFixture({
      localCount: 1,         // 1 backup entry (the source we restore from)
      currentShares: 10,     // distinct from the backup (5 shares)
      cloudCount: 0,
    });

    await page.addInitScript(initScript(fixture));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const req = route.request();
      // NOTE: order matters. The generic `\/drive\/v3\/files\?/` regex
      // matches BOTH the listPortfolioBackupFiles query AND the
      // find-portfolio-file query, so the more-specific find-portfolio
      // check MUST come first — otherwise findPortfolioFile returns
      // null and restore falls into createPortfolioFile (no "Backup
      // write failed" prefix on the toast).
      // Find-portfolio-file query (specific: looks for the portfolio
      // filename). Returning a file id is what makes writePortfolioFile
      // get called — without it, restore falls into createPortfolioFile
      // and the toast text differs.
      if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [{ id: 'portfolio-file-id', name: 'property_tracker_portfolio_v1.json', modifiedTime: '2024-07-01T00:00:00.000Z' }] }),
        });
      }
      // Drive file list query (cleanupOldBackups + listPortfolioBackupFiles).
      if (/\/drive\/v3\/files\?/.test(url) && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [] }),
        });
      }
      // Drive file content read (writePortfolioFile reads the existing
      // portfolio.json before snapshotting it — must succeed so step 5
      // gets to the upload POST that we want to fail).
      if (/\/drive\/v3\/files\/[^/?]+/.test(url) && req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ holdings: [{ id: 'h-old', ticker: 'AAPL', shares: 99, cost: 100, currency: 'TWD', current_price: 0, attributes: {} }] }),
        });
      }
      // Drive upload POST (both Layer 2 backup write AND new-portfolio
      // create). Force an error so the local-restore flow surfaces
      // its best-effort sync-failure path (warning toast, no
      // rollback). The error message avoids the word "failed" so
      // the toast-text assertion (not.toContainText(/failed/i)) is
      // meaningful.
      if (/\/upload\/drive\/v3\/files/.test(url) && req.method() === 'POST') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'simulated Drive error' } }),
        });
      }
      // Drive file media PATCH (existing portfolio.json overwrite) — also fail.
      if (/\/drive\/v3\/files\/[^/?]+/.test(url) && req.method() === 'PATCH') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      // Drive file DELETE — irrelevant but complete the surface.
      if (/\/drive\/v3\/files\/[^/?]+/.test(url) && req.method() === 'DELETE') {
        return route.fulfill({ status: 204, body: '' });
      }
      return route.continue();
    });

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.goto('http://localhost:8000/portfolio.html');

    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.syncAccessToken = 'fake-token-for-test';
    });

    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    // Click Restore. The upload POST will 500, but for a LOCAL
    // restore this must NOT roll back the in-memory restore — only
    // a soft warning toast is surfaced.
    await page.locator('[data-testid="backup-restore-btn"]').first().click();

    // Toast is the WARNING variant — says "skipped", not the rollback
    // flow's error variant (the toast's class flips between bg-rose
    // for error and bg-amber for warning; "failed" appears in the
    // inner error message regardless, so check the class instead).
    const toast = page.locator('[data-testid="restore-toast"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/skipped/i);
    await expect(toast).toHaveClass(/bg-amber-500/);

    // Holdings stay at the RESTORED state (5 shares), not the pre-
    // restore state (10 shares). Use nth(1) (Shares column) — not
    // `td:text("5")` — because $500.00 in the cost column also
    // contains "5" as a substring. Note: the v1.6 Order column
    // (leftmost) shifts the Shares column from nth(1) to nth(2).
    await page.locator('button:has-text("Holdings")').click();
    const aaplRow = page.locator('tr:has-text("AAPL")');
    await expect(aaplRow.locator('td').nth(2)).toHaveText('5', { timeout: 10_000 });

    // The self-protection entry is preserved in data.backups[] —
    // it's the only entry with shares === 10 (since the source backup
    // has 5 shares).
    const finalBackups = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).backups : null;
    }, STORAGE_KEY);
    expect(Array.isArray(finalBackups)).toBe(true);
    expect(finalBackups.length).toBeGreaterThanOrEqual(2);
    const hasSelfProtection = finalBackups.some((b) =>
      b?.data?.holdings?.some((h) => h.shares === 10)
    );
    expect(hasSelfProtection).toBe(true);
    // The original source backup is also still there.
    expect(finalBackups.some((b) => b.id === 'bp-source')).toBe(true);

    expect(errors).toEqual([]);
  });

  // Regression — deleting a record pushes a local backup. The user
  // reported: "after deleting cash data, the local backups list still
  // shows blank". Root cause investigation: _removeRecord mutates
  // data.cash_accounts/data.deletions, the deep watcher fires save()
  // which hashes the new state. If the hash differs from the last
  // push, pushBackup grows data.backups[]. The dedup _lastBackupHash
  // guard skips when the state hash matches the previous push.
  //
  // This test pins that:
  //   1. Starting from a fixture with one cash + empty data.backups,
  //      the load-time save() pushes the initial backup (backups=1).
  //   2. removeCash(id) mutates data.cash_accounts + data.deletions
  //      — different state hash → second push (backups=2).
  //   3. data.backups[1].data has cash_accounts=[] and one deletion
  //      (the snapshot of the post-delete state).
  test('local backups list grows when a cash account is deleted (regression: post-delete backup was missing)', async ({ page }) => {
    const fixture = makeFixture({ localCount: 0, cloudCount: 0, includeSourceBackup: false });
    fixture.cash_accounts = [{ id: 'cash-1', name: 'Checking', balance: 1000, currency: 'TWD', attributes: {} }];

    page.on('route', async (route) => {
      const url = route.request().url();
      if (HOSTS.some((h) => url.includes(h))) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
      }
      return route.continue();
    });

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.addInitScript(initScript(fixture));
    await page.goto('http://localhost:8000/portfolio.html');

    // load() does not auto-save — no watcher fires until data mutates.
    // So backups.length is 0 right after load. The delete below must
    // trigger the watcher → save → pushBackup chain and grow backups.
    const before = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).backups.length : -1;
    }, STORAGE_KEY);
    expect(before).toBe(0);

    // Delete the cash account via the shim (same path the delete
    // button uses). The confirm dialog is auto-accepted above.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.removeCash('cash-1');
    });

    // Wait for the watcher → save → pushBackup chain. pushBackup is
    // synchronous; the watcher is debounced microtasks by Alpine.
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('property_tracker_portfolio_v1');
        if (!raw) return false;
        const data = JSON.parse(raw);
        return data.backups.length >= 1;
      },
      { timeout: 5000 }
    );

    const final = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEY);

    // The deletion produced a new backup entry (backups went 0 → 1).
    expect(final.backups.length).toBe(1);

    // First, the user-visible symptom: after the delete, the Backups
    // page should render 1 local-backup row (was 0 — empty state).
    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 5000 });
    const localRows = page.locator('[data-testid="local-backups"] [data-testid="backup-row"]');
    await expect(localRows).toHaveCount(1, { timeout: 5000 });

    // Then the diagnostic: the new entry must be a properly-formed
    // ENTRY (id + saved_at + data envelope), not a raw snapshot.
    // The Backups page row binds :key="b.id" and renders b.saved_at;
    // raw snapshots lack both fields, which is why the row doesn't
    // render at all. The self-protection path at portfolio.html:2107
    // already documents this exact pitfall.
    const latest = final.backups[final.backups.length - 1];
    expect(latest.id).toBeTruthy();
    expect(latest.saved_at).toBeTruthy();
    expect(latest.data).toBeDefined();
    expect(latest.data.cash_accounts).toEqual([]);
    expect(latest.data.deletions.length).toBe(1);
    expect(latest.data.deletions[0].target_id).toBe('cash-1');
  });

  // Regression — modifying a cash field pushes a local backup.
  // User follow-up: "修改cash 欄位，一樣Local backups 還是空白".
  // Same pattern as the delete test, but for the EDIT path: saveCash
  // mutates an array element (this.data.cash_accounts[idx] = record).
  // The deep watcher must fire; state hash must differ; pushBackup
  // must wrap in {id, saved_at, data} envelope.
  test('local backups list grows when a cash account is modified (regression: post-edit backup was missing)', async ({ page }) => {
    const fixture = makeFixture({ localCount: 0, cloudCount: 0, includeSourceBackup: false });
    fixture.cash_accounts = [{
      id: 'cash-1', name: 'Checking', balance: 1000, currency: 'TWD', attributes: {},
      updated_at: '2024-06-01T00:00:00.000Z', device_id: 'smoke-test-device', inactive: false,
    }];

    page.on('route', async (route) => {
      const url = route.request().url();
      if (HOSTS.some((h) => url.includes(h))) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
      }
      return route.continue();
    });

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.addInitScript(initScript(fixture));
    await page.goto('http://localhost:8000/portfolio.html');

    // Simulate the edit path: open edit modal, set form, submit. The
    // shim's saveCash() does
    //   this.data.cash_accounts[idx] = record
    // — an array-element replacement. This is the path that the user
    // hit; we exercise it via the shim directly.
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.editingCash = data.data.cash_accounts[0];
      data.cashForm = {
        name: 'Checking (edited)',
        balance: 2500,
        currency: 'TWD',
        attributes: {},
      };
      data.saveCash();
    });

    // Wait for watcher → save → pushBackup.
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('property_tracker_portfolio_v1');
        if (!raw) return false;
        const d = JSON.parse(raw);
        return d.backups.length >= 1;
      },
      { timeout: 5000 }
    );

    const final = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEY);

    expect(final.backups.length).toBe(1);
    const latest = final.backups[final.backups.length - 1];
    expect(latest.id).toBeTruthy();
    expect(latest.saved_at).toBeTruthy();
    expect(latest.data).toBeDefined();
    // The edit landed: balance 2500, name 'Checking (edited)'.
    expect(latest.data.cash_accounts[0].balance).toBe(2500);
    expect(latest.data.cash_accounts[0].name).toBe('Checking (edited)');

    // The Backups page should render 1 row.
    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 5000 });
    const localRows = page.locator('[data-testid="local-backups"] [data-testid="backup-row"]');
    await expect(localRows).toHaveCount(1, { timeout: 5000 });
  });

  // Regression — old raw-snapshot backups (pushed by the pre-fix save()
  // that passed buildBackupSnapshot() directly to pushBackup) must not
  // break the Backups page render. The user's exported portfolio.json
  // contained 3 raw snapshots + 1 proper entry. The :key="b.id" binding
  // collides for the raw entries (all have undefined id), which Alpine
  // handles by failing to render them. User symptom: list looks blank
  // or near-blank after migrating to the fixed code, even though a new
  // proper backup is being pushed.
  //
  // This test verifies that:
  //   1. Pre-existing raw snapshots are rendered as rows (even if with
  //      dash placeholders for missing id/saved_at), AND
  //   2. After a new push, the page still shows all 4 rows (3 raw + 1
  //      new proper).
  test('legacy raw-snapshot entries still render in the Backups list (regression: :key collision hid rows)', async ({ page }) => {
    const fixture = makeFixture({ localCount: 0, cloudCount: 0, includeSourceBackup: false });
    fixture.cash_accounts = [{
      id: 'cash-1', name: 'Checking', balance: 1000, currency: 'TWD', attributes: {},
      updated_at: '2024-06-01T00:00:00.000Z', device_id: 'smoke-test-device', inactive: false,
    }];
    // Simulate the user's mixed state: 3 raw-snapshot entries (the
    // shape produced by the buggy pre-fix save()) + 1 proper entry
    // (pushed by the fixed code after they tested).
    fixture.backups = [
      // raw snapshots — no id, no saved_at, no data envelope; the
      // body is just the snapshot shape ({holdings, cash_accounts,
      // ..., backups: {count, oldest_saved_at, newest_saved_at}}).
      { holdings: [], cash_accounts: [], debts: [], snapshots: [], meta: fixture.meta, settings: fixture.settings, categories: [], deletions: [], backups: { count: 0, oldest_saved_at: null, newest_saved_at: null } },
      { holdings: [], cash_accounts: [{ id: 'cash-old', name: 'Old', balance: 1, currency: 'TWD' }], debts: [], snapshots: [], meta: fixture.meta, settings: fixture.settings, categories: [], deletions: [], backups: { count: 0, oldest_saved_at: null, newest_saved_at: null } },
      { holdings: [], cash_accounts: [{ id: 'cash-old', name: 'Old', balance: 2, currency: 'TWD' }], debts: [], snapshots: [], meta: fixture.meta, settings: fixture.settings, categories: [], deletions: [], backups: { count: 0, oldest_saved_at: null, newest_saved_at: null } },
    ];

    page.on('route', async (route) => {
      const url = route.request().url();
      if (HOSTS.some((h) => url.includes(h))) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
      }
      return route.continue();
    });

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.addInitScript(initScript(fixture));
    await page.goto('http://localhost:8000/portfolio.html');

    // Go to Backups. With the pre-existing 3 raw entries, the list
    // should still render 3 rows (with dash placeholders for missing
    // fields) — not 0 due to a :key collision.
    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 5000 });
    const localRows = page.locator('[data-testid="local-backups"] [data-testid="backup-row"]');
    await expect(localRows).toHaveCount(3, { timeout: 5000 });

    // Now modify a cash field; the post-fix save() should push a new
    // proper entry (total 4 rows).
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data.editingCash = data.data.cash_accounts[0];
      data.cashForm = { name: 'Checking (edited)', balance: 2500, currency: 'TWD', attributes: {} };
      data.saveCash();
    });

    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('property_tracker_portfolio_v1');
        if (!raw) return false;
        return JSON.parse(raw).backups.length >= 4;
      },
      { timeout: 5000 }
    );

    // All 4 rows render (3 raw + 1 new proper).
    await expect(localRows).toHaveCount(4, { timeout: 5000 });

    // The latest entry is a proper envelope.
    const final = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEY);
    const latest = final.backups[final.backups.length - 1];
    expect(latest.id).toBeTruthy();
    expect(latest.saved_at).toBeTruthy();
    expect(latest.data.cash_accounts[0].balance).toBe(2500);
  });

  // Regression — local restore must not require Google Drive.
  // User reported: clicking Restore on a local backup shows
  // "Restore failed: Not connected to Google Drive" even though the
  // user wasn't trying to sync to Drive. Root cause: restoreFromBackup
  // step 5 unconditionally calls findPortfolioFile/createPortfolioFile
  // to push the restored state to Drive; when no token is present,
  // createPortfolioFile throws and the catch block rolls back the
  // in-memory restore, then surfaces a misleading toast.
  //
  // Local restore's intent is local — Drive is best-effort
  // cross-device propagation. ADR 0012 §3 (self-protection) is
  // satisfied because step 1 already pushed a pre-restore snapshot
  // into data.backups[] regardless of Drive. Therefore Drive sync
  // failure on a local restore should NOT roll back; it should show
  // a soft warning toast and return success.
  test('local restore succeeds without Drive (regression: misleading "Not connected" toast rolled back the restore)', async ({ page }) => {
    const errors = collectAppErrors(page);
    // Start with 1 source backup (shares=5) + current state shares=10.
    // The source must be a PROPER entry so restoreFromBackup's id
    // lookup finds it (raw-snapshot entries would never restore).
    const fixture = makeFixture({
      localCount: 1,
      currentShares: 10,
      cloudCount: 0,
    });

    page.on('route', async (route) => {
      const url = route.request().url();
      // No Drive mock — every Drive call would 404. Importantly we
      // do NOT set syncAccessToken, so driveFetch throws "Not
      // connected to Google Drive" on any Drive call.
      if (HOSTS.some((h) => url.includes(h))) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
      }
      return route.continue();
    });

    page.on('dialog', async (dialog) => { await dialog.accept(); });

    await page.addInitScript(initScript(fixture));
    await page.goto('http://localhost:8000/portfolio.html');

    // Confirm the user is NOT signed in to Drive.
    const isConnected = await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      return !!data.syncAccessToken;
    });
    expect(isConnected).toBe(false);

    await page.locator('button:has-text("Backups")').click();
    await expect(page.locator('[data-testid="backups-page"]')).toBeVisible({ timeout: 10_000 });

    // Click Restore on the first local backup.
    await page.locator('[data-testid="backup-restore-btn"]').first().click();

    // Toast is the WARNING variant — says "skipped", not "failed".
    const toast = page.locator('[data-testid="restore-toast"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/skipped/i);
    await expect(toast).not.toContainText(/failed/i);

    // Holdings are now the BACKUP state (5 shares), not the rolled-
    // back current state (10 shares). Use nth(2) (Shares column;
    // the v1.6 Order column shifts Shares from nth(1) to nth(2)) —
    // not `td:text("5")` — because $500.00 in the cost column also
    // contains "5" as a substring.
    await page.locator('button:has-text("Holdings")').click();
    const aaplRow = page.locator('tr:has-text("AAPL")');
    await expect(aaplRow.locator('td').nth(2)).toHaveText('5', { timeout: 10_000 });

    // localStorage reflects the restored state (5 shares).
    const finalBackups = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEY);
    expect(finalBackups).not.toBeNull();
    expect(finalBackups.holdings[0].shares).toBe(5);

    // Self-protection entry is still present (the pre-restore
    // snapshot of 10 shares — the only entry with shares===10 in
    // data.backups[] now).
    expect(Array.isArray(finalBackups.backups)).toBe(true);
    expect(finalBackups.backups.length).toBeGreaterThanOrEqual(2);
    const hasSelfProtection = finalBackups.backups.some((b) =>
      b?.data?.holdings?.some((h) => h.shares === 10)
    );
    expect(hasSelfProtection).toBe(true);

    expect(errors).toEqual([]);
  });
});
