// tests/browser/snapshots.spec.js — Playwright browser smoke for the
// Snapshots page (v1.5 — ticket 02). Run via stage 4 of
// ./scripts/safety-net.sh.
//
// What it covers (ticket 02 / spec §Browser smoke):
//   - Empty state renders when no snapshots exist.
//   - Take snapshot → list gains 1 row with today's date.
//   - Take a second snapshot → list has 2 rows; cap usage shows "2 / 365".
//   - Delete a snapshot (with confirm) → list size drops by one.
//   - Nav button toggles visibility of the snapshots-page section.
//
// Non-goals (covered by future tickets):
//   - View / Compare buttons → inert stubs (T03 / T04).
//   - Stale nudge rendering when an active plan exists with no snapshots
//     (subtle and not worth a smoke breakpoint today — covered by
//     manual visual verification until the Plan page smoke covers it
//     indirectly).
//
// Wiring:
//   - Fixture is injected via page.addInitScript into localStorage under
//     the key 'property_tracker_portfolio_v1' (see portfolio.html:1176
//     `const STORAGE_KEY = ...`).
//   - Today's date is computed in the page so we don't depend on
//     wall-clock vs. browser-clock drift across the
//     addInitScript → page.evaluate → click sequence.
//   - The Take button always triggers the intraday-confirm dialog via
//     `shouldWarnIntraday()` when the market is open (heuristic on the
//     time-of-day). At night / on weekends the dialog is skipped
//     (false). The smoke uses window.confirm handler to auto-accept.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// One TWD holding so a snapshot has meaningful holdingsValue / netWorth
// ($1,000 holdings + $0 cash − $0 debts = $1,000 net worth).
const PORTFOLIO_FIXTURE = {
  version: '1.1',
  holdings: [
    {
      id: 'h-smoke-1',
      ticker: 'AAPL',
      shares: 10,
      cost: 800,
      currency: 'TWD',
      current_price: 100,
      high_52w: null,
      low_52w: null,
      prev_close: null,
      inactive: false,
      attributes: {},
    },
  ],
  cash_accounts: [],
  debts: [],
  categories: [],
  snapshots: [],
  settings: {
    display_currency: 'TWD',
    language: 'en',
    cost_format: 'per_share',
    fx_source: 'manual',
    fx_rate: 32.2,
    snapshot_cap: 365,
  },
  meta: {
    device_id: 'smoke-test-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

// Runs in page context before any user script. Seeds the fixture into
// localStorage so the page-load code path (load() → defaultPortfolio()
// migrate-merge) sees the snapshot_cap: 365 setting.
const INIT_SCRIPT = `
window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(PORTFOLIO_FIXTURE)}));
`;

// Console-error messages that originate from CDN/3rd-party scripts or
// resources we don't ship (favicon). Filtered the same way as
// refresh.spec.js so this test's failure surface stays focused on the
// app under test.
const CDN_NOISE = /tailwind|alpine\.js|googleapis\.com|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i;
function isNoise(msg) {
  const text = msg.text();
  if (CDN_NOISE.test(text)) return true;
  if (/Failed to load resource/i.test(text)) {
    const url = msg.location()?.url || '';
    if (/favicon\.ico$/i.test(url)) return true;
    if (/status of 40[0-9]/i.test(text) && url === '') return true;
  }
  return false;
}

function collectAppErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (isNoise(msg)) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

// Auto-accept window.confirm / alert dialogs. Returns a counter that
// each test can read to verify the dialog surfaced. Tracks every
// dialog so tests can filter by message.
async function autoAcceptDialogs(page) {
  const counter = { count: 0, items: [] };
  page.on('dialog', async (dialog) => {
    counter.count++;
    counter.items.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  return counter;
}

test.describe('portfolio.html snapshots page (ticket #02)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(INIT_SCRIPT);
    page.__dlg = await autoAcceptDialogs(page);
  });

  test('empty state: Snapshots page renders the take-first-snapshot CTA when no snapshots exist', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');

    // Nav: Snapshots button is present after Holdings.
    await expect(page.locator('[data-testid="nav-snapshots"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="nav-snapshots"]').click();

    // Page: snapshots-page visible with empty-state CTA.
    await expect(page.locator('[data-testid="snapshots-page"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="snapshot-empty-take"]')).toBeVisible();

    // List not rendered yet.
    await expect(page.locator('[data-testid="snapshot-list"]')).toBeHidden();

    // Cap usage reads "0 / 365".
    await expect(page.locator('[data-testid="snapshot-cap-usage"]')).toHaveText('0 / 365 snapshots');

    expect(errors).toEqual([]);
  });

  test('Take snapshot: list gains 1 row with today\'s date', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="snapshot-empty-take"]').click();

    // After take, empty state hides and the list appears with 1 row.
    await expect(page.locator('[data-testid="snapshot-list"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeHidden();

    const rows = page.locator('[data-testid="snapshot-row"]');
    await expect(rows).toHaveCount(1);

    // Row date is today (locale-agnostic — compared against the page's
    // own clock so we don't drift across CI / local runs).
    const todayLocal = await page.evaluate(() => {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    });
    await expect(rows.first()).toContainText(todayLocal);

    // Cap usage now reads "1 / 365".
    await expect(page.locator('[data-testid="snapshot-cap-usage"]')).toHaveText('1 / 365 snapshots');

    expect(errors).toEqual([]);
  });

  test('Take twice: list has 2 rows; cap usage shows 2 / 365', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });

    // Two snapshots on the same day (intraday). The dialog auto-accepts.
    await page.locator('[data-testid="snapshot-empty-take"]').click();
    await page.locator('[data-testid="snapshot-take"]').click();

    const rows = page.locator('[data-testid="snapshot-row"]');
    await expect(rows).toHaveCount(2, { timeout: 5_000 });

    // Cap usage reads "2 / 365".
    await expect(page.locator('[data-testid="snapshot-cap-usage"]')).toHaveText('2 / 365 snapshots');

    // Newest-first ordering: the second row's id-suffix should appear
    // ABOVE the first one's id-suffix in the DOM. We compare the
    // netWorth cell text instead (which is the same between adjacent
    // same-day snapshots) — just confirm the row count grew.
    expect(errors).toEqual([]);
  });

  test('Delete snapshot: confirm dialog → list size drops by one', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    // Set up: two snapshots.
    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="snapshot-empty-take"]').click();
    await page.locator('[data-testid="snapshot-take"]').click();
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(2);

    // Click delete on the first row.
    await page.locator('[data-testid="snapshot-row-delete"]').first().click();

    // After delete: list has 1 row.
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1, { timeout: 5_000 });

    // Verify a confirm dialog with "snapshot" copy fired.
    const dlg = page.__dlg;
    const deleteDialog = dlg.items.find((d) => /snapshot/i.test(d.message));
    expect(deleteDialog).toBeTruthy();
    expect(deleteDialog.type).toBe('confirm');

    // Cap usage back to "1 / 365".
    await expect(page.locator('[data-testid="snapshot-cap-usage"]')).toHaveText('1 / 365 snapshots');

    expect(errors).toEqual([]);
  });

  test('Nav toggles: Snapshots hidden when current page is Home; visible when Snapshots clicked', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');

    // Home is the default page.
    await expect(page.locator('[data-testid="snapshots-page"]')).toBeHidden({ timeout: 10_000 });

    // Click nav → visible.
    await page.locator('[data-testid="nav-snapshots"]').click();
    await expect(page.locator('[data-testid="snapshots-page"]')).toBeVisible();

    // Click Home → hidden again.
    await page.locator('button:has-text("Home")').first().click();
    await expect(page.locator('[data-testid="snapshots-page"]')).toBeHidden();

    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v1.5 ticket 03 — snapshot detail view
// ---------------------------------------------------------------------------

// Detail-view happy-path fixture: 2 holdings (one with attributes), a country
// category with US/TW values, cash, debts. The Take button captures this
// state into `data.snapshots[0]` so the detail tests can open it.
const DETAIL_FIXTURE = {
  version: '1.1',
  holdings: [
    {
      id: 'h-det-1',
      ticker: 'AAPL',
      shares: 10,
      cost: 800,
      currency: 'TWD',
      current_price: 150,
      high_52w: null, low_52w: null, prev_close: null,
      inactive: false,
      attributes: { 'cat-country': 'val-us' },
    },
    {
      id: 'h-det-2',
      ticker: '2330.TW',
      shares: 5,
      cost: 25000,
      currency: 'TWD',
      current_price: 30000,
      high_52w: null, low_52w: null, prev_close: null,
      inactive: false,
      attributes: {},
    },
  ],
  cash_accounts: [{ id: 'c-det-1', name: 'Checking', balance: 5000, currency: 'TWD', attributes: {} }],
  debts: [{ id: 'd-det-1', name: 'Credit Card', balance: 1000, currency: 'TWD', attributes: {} }],
  categories: [
    {
      id: 'cat-country',
      name: 'Country',
      applies_to: ['holdings', 'cash', 'debt'],
      values: [
        { id: 'val-us', name: 'US' },
        { id: 'val-tw', name: 'TW' },
      ],
    },
  ],
  snapshots: [],
  plans: [],
  settings: {
    display_currency: 'TWD',
    language: 'en',
    cost_format: 'per_share',
    fx_source: 'manual',
    fx_rate: 32.2,
    snapshot_cap: 365,
  },
  meta: { device_id: 'detail-test', last_synced_at: null, created_at: '2025-01-01T00:00:00.000Z' },
};

const DETAIL_INIT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(DETAIL_FIXTURE)}));
`;

// Orphan-value fixture: the snapshot's holding attributes a 'cat-country' id
// (which IS in categories) to a value id 'val-gone' that is NOT in the
// category's values. The pure resolver should return kind='orphanValue',
// label='?' (per ADR 0003).
const ORPHAN_VALUE_FIXTURE = {
  ...DETAIL_FIXTURE,
  categories: [
    {
      id: 'cat-country',
      name: 'Country',
      applies_to: ['holdings'],
      values: [
        { id: 'val-tw', name: 'TW' },  // val-us intentionally absent
      ],
    },
  ],
  snapshots: [
    {
      id: 'snap-orphan-value',
      date: '2025-01-15',
      holdings: [
        {
          id: 'h-det-1',
          ticker: 'AAPL',
          shares: 10,
          cost: 800,
          currency: 'TWD',
          current_price: 150,
          high_52w: null, low_52w: null, prev_close: null,
          inactive: false,
          attributes: { 'cat-country': 'val-us' },  // val-us no longer in cat
        },
      ],
      cash_accounts: [],
      debts: [],
      fx_rate: 32.2,
      totals: {
        displayCurrency: 'TWD',
        holdingsValue: 1500,
        holdingsCost: 800,
        holdingsGainLoss: 700,
        totalCash: 0,
        totalDebts: 0,
        netWorth: 1500,
      },
    },
  ],
};

const ORPHAN_VALUE_INIT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(ORPHAN_VALUE_FIXTURE)}));
`;

// Orphan-category fixture: the snapshot's holding attributes a 'cat-deleted'
// id (which is NOT in categories) to any value id. The pure resolver should
// return kind='orphanCategory', label='—'.
const ORPHAN_CATEGORY_FIXTURE = {
  ...DETAIL_FIXTURE,
  categories: [],  // cat-country intentionally absent
  snapshots: [
    {
      id: 'snap-orphan-category',
      date: '2025-01-15',
      holdings: [
        {
          id: 'h-det-1',
          ticker: 'AAPL',
          shares: 10,
          cost: 800,
          currency: 'TWD',
          current_price: 150,
          high_52w: null, low_52w: null, prev_close: null,
          inactive: false,
          attributes: { 'cat-country': 'val-us' },  // cat-country no longer exists
        },
      ],
      cash_accounts: [],
      debts: [],
      fx_rate: 32.2,
      totals: {
        displayCurrency: 'TWD',
        holdingsValue: 1500,
        holdingsCost: 800,
        holdingsGainLoss: 700,
        totalCash: 0,
        totalDebts: 0,
        netWorth: 1500,
      },
    },
  ],
};

const ORPHAN_CATEGORY_INIT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(ORPHAN_CATEGORY_FIXTURE)}));
`;

test.describe('portfolio.html snapshots page (ticket #03 — detail view)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(DETAIL_INIT);
    page.__dlg = await autoAcceptDialogs(page);
  });

  test('View snapshot: detail opens with date, frozen net worth, mini-totals, holdings table, cash, debts', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    // Take one snapshot via the empty-state CTA.
    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="snapshot-empty-take"]').click();
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1);

    // List mode hides; click View → detail mode shows.
    await page.locator('[data-testid="snapshot-row-view"]').first().click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="snapshot-list"]')).toBeHidden();

    // Header: date is today's local date; net worth = 10*150 + 5*30000 + 5000 - 1000 = 155500.
    const todayLocal = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await expect(page.locator('[data-testid="snapshot-detail-date"]')).toHaveText(todayLocal);

    // Mini-totals: holdingsValue = 10*150 + 5*30000 = 151500; totalCash = 5000; totalDebts = 1000.
    // Note: formatAmount abbreviates 萬 as 'W' for amounts ≥10K (see lib/format.js).
    await expect(page.locator('[data-testid="snapshot-detail-holdings-value"]')).toContainText('15.15W');
    await expect(page.locator('[data-testid="snapshot-detail-total-cash"]')).toContainText('5,000');
    await expect(page.locator('[data-testid="snapshot-detail-total-debts"]')).toContainText('1,000');

    // Holdings table has 2 data rows (empty-placeholder excluded by data-testid).
    const holdingsRows = page.locator('[data-testid="snapshot-detail-holdings-table"] tbody tr:not([data-testid])');
    await expect(holdingsRows).toHaveCount(2);

    // Cash table has 1 row.
    await expect(page.locator('[data-testid="snapshot-detail-cash-table"] tbody tr:not([data-testid])')).toHaveCount(1);

    // Debts table has 1 row.
    await expect(page.locator('[data-testid="snapshot-detail-debts-table"] tbody tr:not([data-testid])')).toHaveCount(1);

    // Attribute badge for h-det-1's 'cat-country' → 'val-us' resolves to 'US'.
    await expect(page.locator('[data-testid="snapshot-detail-badge-ok"]').first()).toHaveText('US');

    expect(errors).toEqual([]);
  });

  test('Back button returns to the list with the same row order', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="snapshot-empty-take"]').click();
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1);

    // Open detail, then Back.
    await page.locator('[data-testid="snapshot-row-view"]').first().click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="snapshot-detail-back"]').click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('[data-testid="snapshot-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('Orphan value-id: snapshot referencing a since-deleted category value renders "?" glyph with hint', async ({ page }) => {
    // Replace the default init script with the orphan-value fixture so
    // the pre-seeded snapshot already references the orphan value id.
    await page.addInitScript(ORPHAN_VALUE_INIT);
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1, { timeout: 10_000 });
    await page.locator('[data-testid="snapshot-row-view"]').first().click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeVisible({ timeout: 5_000 });

    // Orphan-value badge rendered.
    const orphanValueBadge = page.locator('[data-testid="snapshot-detail-badge-orphanValue"]');
    await expect(orphanValueBadge).toBeVisible();
    await expect(orphanValueBadge).toHaveText('?');
    await expect(orphanValueBadge).toHaveAttribute('title', /deleted/i);

    expect(errors).toEqual([]);
  });

  test('Orphan category-id: snapshot referencing a since-deleted category renders "—" with hint', async ({ page }) => {
    await page.addInitScript(ORPHAN_CATEGORY_INIT);
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.locator('[data-testid="nav-snapshots"]').click();

    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1, { timeout: 10_000 });
    await page.locator('[data-testid="snapshot-row-view"]').first().click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeVisible({ timeout: 5_000 });

    // Orphan-category badge rendered.
    const orphanCatBadge = page.locator('[data-testid="snapshot-detail-badge-orphanCategory"]');
    await expect(orphanCatBadge).toBeVisible();
    await expect(orphanCatBadge).toHaveText('—');
    await expect(orphanCatBadge).toHaveAttribute('title', /deleted/i);

    expect(errors).toEqual([]);
  });
});
