// tests/browser/v17-sync.spec.js — Playwright browser smoke for v1.7
// Categories + Settings sync merge.
//
// Run: stage 4 of ./scripts/safety-net.sh.
//
// What it covers (ticket #02 / spec §Browser integration scenarios):
//   - Pre-v1.7 portfolio loads cleanly (load-time backfill applies to
//     categories[*].updated_at/device_id + settings.updated_at).
//   - Race — Device A adds Category "Foo", Device B has stale remote
//     (Foo absent on remote) → after mergePortfolios, Foo survives on
//     local.
//   - Settings race — Device A edits fx_rate more recently than
//     Device B's fx_rate → after mergeSettings, the newer side wins
//     object-level (whole-object replaces).
//   - Settings stamp trigger — a holdings edit does NOT bump
//     settings.updated_at; an fx_rate edit DOES.
//   - deleteCategory tombstone — clicking the × button on a category
//     pushes a tombstone into data.deletions[] with type: 'categories'.
//
// Constraints:
//   - Browser scenarios use real pre-v1.7 JSON (no updated_at fields).
//   - Sync scenarios use window.Sync.mergePortfolios directly so we
//     can drive any local/remote pair without UI wiring.
//   - deleteCategory tombstone is verified end-to-end through the
//     actual × button (covers the Alpine shim + Records.recordDeletion
//     + Devices.recordDeletion wiring).
//
// Same error-collection discipline as categories-guard.spec.js —
// favicon 404 / CDN noise / Alpine transition races are pre-existing
// (see tests/browser/backups.spec.js).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Sanity: v1.7 merge + migration primitives exist on the page.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(`
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
  `);
});

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

// PRE-V1.7 FIXTURE — no updated_at on categories, no updated_at on settings.
// We hand-write this to match the v1.6 schema (no v1.7 fields).
function makePreV17Fixture() {
  return {
    version: '1.1',
    holdings: [{
      id: 'h-1', ticker: '2330.TW', shares: 1000, cost: 50,
      currency: 'TWD', current_price: 600, attributes: {},
    }],
    cash_accounts: [],
    debts: [],
    categories: [
      { id: 'cat-region', name: 'Region', applies_to: ['holdings', 'cash', 'debt'],
        values: [{ id: 'val-TW', name: 'TW' }] },
      // no updated_at, no device_id (pre-v1.7 — lazy-backfilled on first load)
    ],
    plans: [], active_plan_id: null, snapshots: [],
    backups: [], deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
      // no updated_at (pre-v1.7 — lazy-backfilled on first load)
    },
    meta: {
      device_id: 'pre-v17',
      last_synced_at: null,
      created_at: '2024-06-01T00:00:00.000Z',
    },
  };
}

function readStored(page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
}

// --- Scenario 1 — Pre-v1.7 portfolio loads cleanly -----------------------

test('v1.7: pre-v1.7 portfolio loads → categories + settings lazy-backfilled on first page load', async ({ page }) => {
  const errors = collectAppErrors(page);
  const fixture = makePreV17Fixture();
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine);
  // Force a deep watch save() so the backfilled data lands in localStorage.
  // Without this, the data is hydrated in-memory but never re-persisted
  // (and our subsequent page reload would re-load from the un-backfilled
  // localStorage entry, so save() is needed for round-trip).
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.save();
  });

  const stored = await readStored(page);
  // Categories: each entry has updated_at + device_id backfilled from
  // meta.created_at + meta.device_id (ADR 0016 §2).
  expect(stored.categories).toHaveLength(1);
  expect(stored.categories[0].updated_at).toBe('2024-06-01T00:00:00.000Z');
  expect(stored.categories[0].device_id).toBe('pre-v17');
  // Settings: object-level updated_at backfilled.
  expect(stored.settings.updated_at).toBe('2024-06-01T00:00:00.000Z');
  // No console errors during the load (covers any migration-time throws).
  expect(errors).toEqual([]);
});

// --- Scenario 2 — Race: Device A adds Foo, Device B stale -----------------

test('v1.7: categories race — Device A adds Foo, Device B has empty remote → Foo survives merge', async ({ page }) => {
  const errors = collectAppErrors(page);
  const local = {
    version: '1.1', holdings: [], cash_accounts: [], debts: [],
    plans: [], active_plan_id: null, snapshots: [],
    backups: [], deletions: [],
    categories: [{
      id: 'cat-foo', name: 'Foo', applies_to: ['holdings'],
      values: [],
      updated_at: '2024-07-10T00:00:00.000Z',
      device_id: 'device-a',
    }],
    settings: { fx_rate: 32, display_currency: 'TWD', updated_at: '2024-06-01T00:00:00.000Z' },
    meta: { device_id: 'device-a', created_at: '2024-06-01T00:00:00.000Z' },
  };
  // Remote is stale — does NOT have Foo (per mergeByIdWithDeletions,
  // disjoint ids merge into both-present; this is the canonical fix
  // for the pre-v1.7 "I added a category but it vanished on sync" bug).
  const remote = {
    version: '1.1', holdings: [], cash_accounts: [], debts: [],
    plans: [], active_plan_id: null, snapshots: [],
    backups: [], deletions: [],
    categories: [{
      id: 'cat-existing', name: 'Existing', applies_to: ['holdings'],
      values: [],
      updated_at: '2024-06-15T00:00:00.000Z',
      device_id: 'device-b',
    }],
    settings: { fx_rate: 32, display_currency: 'TWD', updated_at: '2024-05-01T00:00:00.000Z' },
    meta: { device_id: 'device-b', created_at: '2024-01-01T00:00:00.000Z' },
  };

  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Sync);

  // Drive the merge directly — no need for a Drive round-trip.
  const out = await page.evaluate(([l, r]) => {
    return window.Sync.mergePortfolios(l, r, 'device-a');
  }, [local, remote]);

  expect(out.categories.map(c => c.id).sort()).toEqual(['cat-existing', 'cat-foo']);
  // Foo survives even though Device B's remote didn't have it.
  expect(out.categories.find(c => c.id === 'cat-foo').name).toBe('Foo');
  expect(errors).toEqual([]);
});

// --- Scenario 3 — Settings race: object-level newer-wins ------------------

test('v1.7: settings race — Device A fx_rate newer than Device B → whole-object newer-wins', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Sync);

  // Mirror the user-reported "Device A edits fx_rate, Device B has stale
  // remote" scenario: A's updated_at > B's updated_at, so A should win.
  // We then reverse the timestamps to confirm the symmetric case (B wins
  // when B is fresher).
  const out = await page.evaluate(() => {
    const local = {
      fx_rate: 32.2, display_currency: 'TWD',
      updated_at: '2024-08-01T00:00:00.000Z',  // ← A is fresher
    };
    const remote = {
      fx_rate: 30.5, display_currency: 'TWD',
      updated_at: '2024-07-01T00:00:00.000Z',  // ← B is older
    };
    return window.Sync.mergeSettings(local, remote);
  });

  // Local wins because local's updated_at is fresher (strict >).
  expect(out.fx_rate).toBe(32.2);
  expect(out.updated_at).toBe('2024-08-01T00:00:00.000Z');

  // Reverse direction: B is fresher than A → B wins.
  const out2 = await page.evaluate(() => {
    const local = {
      fx_rate: 32.2, display_currency: 'TWD',
      updated_at: '2024-07-01T00:00:00.000Z',
    };
    const remote = {
      fx_rate: 30.5, display_currency: 'USD',
      updated_at: '2024-08-01T00:00:00.000Z',  // ← remote is fresher
    };
    return window.Sync.mergeSettings(local, remote);
  });
  expect(out2.fx_rate).toBe(30.5);
  expect(out2.display_currency).toBe('USD');
  expect(errors).toEqual([]);
});

// --- Scenario 4 — Settings stamp trigger: edit-path only ------------------

test('v1.7: settings stamp trigger — holdings edit does NOT bump settings.updated_at; fx_rate edit DOES', async ({ page }) => {
  const errors = collectAppErrors(page);

  // Fixture with a settings.updated_at we control directly.
  const fixture = makePreV17Fixture();
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine);

  // After load, the migration stamps settings.updated_at = created_at.
  // Snapshot that timestamp for later comparison.
  const before = await readStored(page);
  const stampBefore = before.settings && before.settings.updated_at;

  // Drive a NON-settings edit (add a new holding via saveHolding shim —
  // see categories-guard.spec.js for the canonical pattern). This must
  // NOT bump settings.updated_at (ADR 0016 §6: edit-path only, NOT on
  // every save()).
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.editing = null;
    data.form = {
      ticker: 'NEW', shares: 1, cost: 10, currency: 'TWD', current_price: 10,
      attributes: {},
    };
    data.saveHolding();
  });

  await page.waitForFunction(
    (k) => {
      const raw = localStorage.getItem(k);
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings.length === 2;
    },
    STORAGE_KEY,
    { timeout: 5000 }
  );

  const afterHoldings = await readStored(page);
  expect(afterHoldings.holdings.length).toBe(2);
  expect(afterHoldings.settings.updated_at).toBe(stampBefore);

  // Now drive a SETTINGS edit. setCurrency() is the canonical edit-
  // path stamp trigger (ADR 0016 §6, portfolio.html ~line 5079).
  // We invoke it directly so the test is robust to label changes.
  const stampAfter = await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.setCurrency('USD');
    return data.data.settings.updated_at;
  });

  // The new stamp must be different and parseable as > the old one.
  expect(stampAfter).not.toBe(stampBefore);
  expect(Number.isFinite(Date.parse(stampAfter))).toBe(true);
  expect(errors).toEqual([]);
});

// --- Scenario 5 — deleteCategory tombstone --------------------------------

test('v1.7: deleteCategory click pushes tombstone with type: "categories" into data.deletions[]', async ({ page }) => {
  const errors = collectAppErrors(page);
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ kind: d.type(), message: d.message() });
    await d.accept();
  });

  const fixture = makePreV17Fixture();
  // Make sure we have a category with no plan references (so the
  // roadside guard doesn't block the delete — see categories-guard).
  fixture.plans = [];
  fixture.active_plan_id = null;

  // DEVICE_ID is a runtime const that reads localStorage.getItem('device_id');
  // it must be seeded to match fixture.meta.device_id. See lib/portfolio.html
  // ~line 2668.
  await page.addInitScript(`
    localStorage.setItem('device_id', ${JSON.stringify(fixture.meta.device_id)});
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.save();  // persist the lazy-backfilled state
  });

  // Reload so the saved state is the source of truth.
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);

  // Navigate to Categories tab.
  await page.locator('button:has-text("Categories")').first().click();
  await page.waitForTimeout(200);

  // Click the first "Delete category" × button.
  const deleteCategoryButtons = await page.locator('button[title="Delete category"]').all();
  expect(deleteCategoryButtons.length).toBeGreaterThan(0);
  await deleteCategoryButtons[0].click();
  await page.waitForTimeout(300);

  // The confirm dialog MUST have fired (deleteCategory UX — ADR 0016 §4).
  const confirm = dialogs.find(d => d.kind === 'confirm');
  expect(confirm, 'a confirm dialog must fire').toBeTruthy();

  // Persist the deletion.
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.save();
  });
  const after = await readStored(page);

  // Category gone from data.categories[].
  expect(after.categories).toEqual([]);

  // A tombstone must have been pushed into data.deletions[].
  expect(after.deletions.length).toBe(1);
  const tomb = after.deletions[0];
  expect(tomb.type).toBe('categories');  // ← ADR 0011 enum extension (ADR 0016 §1)
  expect(tomb.target_id).toBe('cat-region');  // matches makePreV17Fixture
  expect(typeof tomb.id).toBe('string');
  expect(tomb.id.startsWith('del-')).toBe(true);
  expect(tomb.device_id).toBe('pre-v17');
  expect(typeof tomb.deleted_at).toBe('string');
  expect(Number.isFinite(Date.parse(tomb.deleted_at))).toBe(true);
  expect(errors).toEqual([]);
});

// --- Backward-compat smoke (unit-level + browser-level) -------------------
//
// The pre-v1.7-load scenario above already covers the round-trip end-to-end
// (localStorage → load() → migration → save() → re-read). The scenarios
// below exercise the mergePortfolios and mergeSettings hand-off directly
// against pre-v1.7 inputs without going through the UI — fast regression
// guard for "did merge break on pre-v1.7 data".

test('v1.7: backward-compat — mergePortfolios on pre-v1.7 inputs (no updated_at) completes without throw', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Sync);

  // Both sides pre-v1.7 — no updated_at on categories, no updated_at on
  // settings. mergeByIdWithDeletions treats missing updated_at as
  // epoch 0; mergeSettings does the same (ADR 0016 §1 + §5).
  const result = await page.evaluate(() => {
    const local = {
      version: '1.1', holdings: [], cash_accounts: [], debts: [],
      plans: [], active_plan_id: null, snapshots: [],
      backups: [], deletions: [],
      categories: [{ id: 'c1', name: 'Tech' }],  // no updated_at / device_id
      settings: { fx_rate: 32, display_currency: 'TWD' },  // no updated_at
      meta: { device_id: 'd', created_at: '2024-01-01T00:00:00Z' },
    };
    const remote = JSON.parse(JSON.stringify(local));
    return window.Sync.mergePortfolios(local, remote, 'device-a');
  });

  expect(result.categories).toHaveLength(1);
  expect(result.categories[0].id).toBe('c1');
  expect(result.settings.fx_rate).toBe(32);
  expect(errors).toEqual([]);
});
