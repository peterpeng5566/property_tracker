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

function withBackupMocks(page, options = {}) {
  const cloudFiles = options.cloudFiles || [];
  return page.route(`**/*`, async (route) => {
    const url = route.request().url();
    const req = route.request();
    // Drive file list query (Layer 2 — listPortfolioBackupFiles).
    if (url.includes('/drive/v3/files?') && req.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: cloudFiles }),
      });
    }
    // Drive file content read (Layer 2 — readPortfolioBackupFile).
    // Path: /drive/v3/files/{id}?alt=media&backup=1 (the latter is the
    // lib's stable contract; some servers also tag Drive reads with
    // ?alt=media alone).
    if (/\/drive\/v3\/files\/[^/?]+(\?|$)/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PRIOR_STATE),
      });
    }
    // Drive file write (Layer 2 — writePortfolioBackupFile creates a new
    // file). Also covers the multipart POST for createPortfolioFile.
    if (url.includes('upload/drive/v3/files') && req.method() === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-backup-file' }),
      });
    }
    // Drive file media PATCH (the existing portfolio.json overwrite).
    if (/\/drive\/v3\/files\/[^/?]+/.test(url) && req.method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    // Drive file DELETE (cleanupOldBackups).
    if (/\/drive\/v3\/files\/[^/?]+/.test(url) && req.method() === 'DELETE') {
      return route.fulfill({ status: 204, body: '' });
    }
    // Find-portfolio-file query (existing pattern).
    if (url.includes("/drive/v3/files?q=") && /name='property_tracker_portfolio_v1.json'/.test(decodeURIComponent(url))) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [{ id: 'portfolio-file-id', name: 'property_tracker_portfolio_v1.json', modifiedTime: '2024-07-01T00:00:00.000Z' }] }),
      });
    }
    // Anything else — pass through.
    return route.continue();
  });
}

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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource/i.test(text)) {
      // Tolerate favicon 404s and any 4xx-without-url (Chromium sometimes
      // surfaces those without msg.location() populated).
      const url = msg.location()?.url || '';
      if (/favicon\.ico$/i.test(url) || (url === '' && /status of 40[0-9]/i.test(text))) return;
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
    // Trigger a re-fetch (cached guard should be reset so we re-fetch).
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const data = window.Alpine.$data(root);
      data._cloudBackupsLoaded = false;
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
});
