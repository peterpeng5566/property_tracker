// tests/browser/ordering.spec.js — Playwright browser smoke for the
// v1.6 record-ordering feature. Run via stage 4 of
// ./scripts/safety-net.sh.
//
// What it covers:
//   - Ticket 01 / spec §Mechanical wiring:
//       * Pre-existing holdings_order: delete a holding via the shim
//         strips its id from the matching order array.
//       * Refresh the page after delete → order array still clean
//         (no stale id).
//       * Cross-collection independence (cash + debts).
//       * Add a new holding when order array absent → order array
//         stays absent (lazy-write preserved).
//   - Ticket 02 / spec §Holdings UI:
//       * No order array → click ↑ on row 2 → row 2 swaps with row 1,
//         array materializes.
//       * Existing order array → click ↓ on row 2 → row 2 swaps with
//         row 3.
//       * Top row ↑ button is disabled; bottom row ↓ button is disabled.
//       * Single holding → both ↑ and ↓ are disabled.
//       * Add a new holding → it appears at the bottom of the table
//         (manual order not violated).
//       * Delete a middle holding → table re-renders without it.
//
// Wiring:
//   - Fixture is injected via page.addInitScript into localStorage
//     under the key 'property_tracker_portfolio_v1'.
//   - T01 scenarios use Alpine shim methods (removeHolding / saveHolding
//     etc.) to avoid depending on the T02 button selectors.
//   - T02 scenarios use the actual buttons via data-testid.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Three holdings + a holdings_order array pre-populated to match. The
// order array is identical to insertion order here, but the test
// exercises the "shim strips deleted id from order array" wiring.
const PORTFOLIO_FIXTURE = {
  version: '1.1',
  holdings: [
    { id: 'h-1', ticker: 'AAPL', shares: 10, cost: 100, currency: 'TWD',
      current_price: 100, high_52w: null, low_52w: null, prev_close: null,
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'h-2', ticker: 'GOOG', shares: 5, cost: 200, currency: 'TWD',
      current_price: 200, high_52w: null, low_52w: null, prev_close: null,
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'h-3', ticker: 'MSFT', shares: 8, cost: 300, currency: 'TWD',
      current_price: 300, high_52w: null, low_52w: null, prev_close: null,
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
  ],
  cash_accounts: [
    { id: 'c-1', name: 'Checking', balance: 1000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'c-2', name: 'Savings', balance: 5000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
  ],
  debts: [
    { id: 'd-1', name: 'Credit card', balance: 2000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
  ],
  // Order arrays pre-materialized — simulates a user who has reordered.
  holdings_order: ['h-1', 'h-2', 'h-3'],
  cash_accounts_order: ['c-1', 'c-2'],
  debts_order: ['d-1'],
  categories: [],
  plans: [],
  active_plan_id: null,
  deletions: [],
  backups: [],
  snapshots: [],
  settings: {
    display_currency: 'TWD',
    language: 'en',
    cost_format: 'per_share',
    fx_source: 'manual',
    fx_rate: 1,
    snapshot_cap: 365,
  },
  meta: {
    device_id: 'smoke',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

const INIT_SCRIPT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(PORTFOLIO_FIXTURE)}));
`;

function autoAcceptDialogs(page) {
  const counter = { count: 0, items: [] };
  page.on('dialog', async (dialog) => {
    counter.count++;
    counter.items.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  return counter;
}

function readStoredOrder(page, key) {
  return page.evaluate((args) => {
    const raw = localStorage.getItem(args.storageKey);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data[args.key];
  }, { storageKey: STORAGE_KEY, key });
}

// --- T01 scenarios --------------------------------------------------------

test('holdings_order: delete a holding strips its id from the matching order array', async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT);
  const dialogs = autoAcceptDialogs(page);
  await page.goto('http://localhost:8000/portfolio.html');

  // Sanity: pre-populated order array is present.
  const before = await readStoredOrder(page, 'holdings_order');
  expect(before).toEqual(['h-1', 'h-2', 'h-3']);

  // Delete h-2 via the same shim the delete button calls.
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.removeHolding('h-2');
  });

  // Wait for the debounced save() watcher to write through.
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return Array.isArray(d.holdings_order) && d.holdings_order.indexOf('h-2') === -1;
    },
    { timeout: 5000 }
  );

  const afterOrder = await readStoredOrder(page, 'holdings_order');
  expect(afterOrder).toEqual(['h-1', 'h-3']);

  const afterHoldings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).holdings.map(h => h.id) : null;
  }, STORAGE_KEY);
  expect(afterHoldings).toEqual(['h-1', 'h-3']);

  // Confirm dialog surfaced (and was auto-accepted).
  expect(dialogs.items.some(i => i.type === 'confirm' && /delete/i.test(i.message))).toBe(true);
});

test('cash_accounts_order + debts_order: delete strips id from matching array only', async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT);
  autoAcceptDialogs(page);
  await page.goto('http://localhost:8000/portfolio.html');

  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.removeCash('c-1');
    data.removeDebt('d-1');
  });

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.cash_accounts_order && d.cash_accounts_order.indexOf('c-1') === -1
          && d.debts_order && d.debts_order.indexOf('d-1') === -1;
    },
    { timeout: 5000 }
  );

  const cashOrder = await readStoredOrder(page, 'cash_accounts_order');
  const debtOrder = await readStoredOrder(page, 'debts_order');
  // Cash removed, debts removed — only this collection is affected.
  expect(cashOrder).toEqual(['c-2']);
  expect(debtOrder).toEqual([]);

  // Holdings order array is untouched (cross-collection independence).
  const holdingsOrder = await readStoredOrder(page, 'holdings_order');
  expect(holdingsOrder).toEqual(['h-1', 'h-2', 'h-3']);
});

test('holdings_order: persists cleanly across page reload', async ({ page }) => {
  // NOTE: we don't use addInitScript here because it re-runs on every
  // navigation (including reload), which would clobber the modified
  // localStorage state after the delete. Instead, seed localStorage
  // via evaluate AFTER the first navigation, then reload — localStorage
  // persists across reloads without re-seeding.
  autoAcceptDialogs(page);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.evaluate((fixture) => {
    localStorage.setItem('property_tracker_portfolio_v1', JSON.stringify(fixture));
  }, PORTFOLIO_FIXTURE);

  // Reload so the page-load code reads the seeded fixture.
  await page.reload();
  // Wait for Alpine boot.
  await page.waitForFunction(() => !!window.Alpine);

  // Delete h-2.
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.removeHolding('h-2');
  });

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings_order && d.holdings_order.indexOf('h-2') === -1;
    },
    { timeout: 5000 }
  );

  // Reload — localStorage persists, page renders from modified state.
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);

  const after = await readStoredOrder(page, 'holdings_order');
  expect(after).toEqual(['h-1', 'h-3']);
  // No stale id anywhere.
  expect(after).not.toContain('h-2');

  // Holdings array also reflects the delete.
  const holdings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).holdings.map(h => h.id) : null;
  }, STORAGE_KEY);
  expect(holdings).toEqual(['h-1', 'h-3']);
});

test('holdings_order: absent array stays absent when adding a new holding (lazy-write)', async ({ page }) => {
  // Fresh fixture — NO holdings_order array. The user has never reordered.
  const fixture = { ...PORTFOLIO_FIXTURE };
  delete fixture.holdings_order;
  delete fixture.cash_accounts_order;
  delete fixture.debts_order;
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await page.goto('http://localhost:8000/portfolio.html');

  // Confirm absent initially.
  const before = await readStoredOrder(page, 'holdings_order');
  expect(before).toBeUndefined();

  // Add a new holding via the saveHolding shim. Use the form state +
  // editing flag that the modal would set.
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

  // The new record is appended to holdings[].
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings.length === 4;
    },
    { timeout: 5000 }
  );

  // Lazy-write preserved: holdings_order is still absent.
  const after = await readStoredOrder(page, 'holdings_order');
  expect(after).toBeUndefined();
});

// --- T02 scenarios --------------------------------------------------------

// Helper: navigate to the Holdings page so the data-testid selectors attach.
async function gotoHoldingsPage(page) {
  await page.goto('http://localhost:8000/portfolio.html');
  // The Holdings page is hidden by default (x-show). Flip currentPage via
  // the Alpine shim rather than clicking the nav button (the nav button
  // has no testid, but the page-render reactivity does).
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'holdings';
  });
  // Wait for Alpine to render the row buttons. We use `state: 'attached'`
  // so we don't depend on the section becoming visible (x-show toggles
  // display:none but the DOM stays attached).
  await page.waitForSelector('[data-testid^="holdings-move-up-"]', { state: 'attached' });
}

// Helper: read the current ticker order as rendered in the Holdings table.
async function readRenderedHoldingsOrder(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid^="holdings-move-up-"]');
    const tickers = [];
    for (const btn of rows) {
      const tr = btn.closest('tr');
      // The new "Order" column is leftmost; ticker is now in the 2nd cell.
      const tickerEl = tr.querySelector('td:nth-child(2) .font-medium');
      if (tickerEl) tickers.push(tickerEl.textContent.trim());
    }
    return tickers;
  });
}

// Helper: navigate to the Cash & Debts page so the data-testid selectors
// attach. Two reusable helpers for reading the rendered account/debt names.
async function gotoCashDebtPage(page) {
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'cash_debt';
  });
  // Wait for at least one cash row button to render.
  await page.waitForSelector('[data-testid^="cash-move-up-"]', { state: 'attached' });
}

async function readRenderedCashOrder(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid^="cash-move-up-"]');
    const names = [];
    for (const btn of rows) {
      const tr = btn.closest('tr');
      // Order column is leftmost; name is in the 2nd cell.
      const nameEl = tr.querySelector('td:nth-child(2) .font-medium');
      if (nameEl) names.push(nameEl.textContent.trim());
    }
    return names;
  });
}

async function readRenderedDebtsOrder(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid^="debts-move-up-"]');
    const names = [];
    for (const btn of rows) {
      const tr = btn.closest('tr');
      const nameEl = tr.querySelector('td:nth-child(2) .font-medium');
      if (nameEl) names.push(nameEl.textContent.trim());
    }
    return names;
  });
}

test('Holdings UI: no order array → click ↑ on row 2 → row 2 swaps with row 1, array materializes', async ({ page }) => {
  // User has 3 holdings, has never reordered → holdings_order is absent.
  const fixture = { ...PORTFOLIO_FIXTURE };
  delete fixture.holdings_order;
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await gotoHoldingsPage(page);

  // Confirm initial state: array absent, table renders in insertion order.
  expect(await readStoredOrder(page, 'holdings_order')).toBeUndefined();
  expect(await readRenderedHoldingsOrder(page)).toEqual(['AAPL', 'GOOG', 'MSFT']);

  // Click ↑ on row 2 (GOOG / h-2).
  await page.click('[data-testid="holdings-move-up-h-2"]');

  // Wait for save to localStorage.
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return Array.isArray(d.holdings_order) && d.holdings_order[0] === 'h-2';
    },
    { timeout: 5000 }
  );

  // Order array materialized with h-2 at the top.
  const order = await readStoredOrder(page, 'holdings_order');
  expect(order).toEqual(['h-2', 'h-1', 'h-3']);

  // Table re-renders with GOOG at the top.
  expect(await readRenderedHoldingsOrder(page)).toEqual(['GOOG', 'AAPL', 'MSFT']);
});

test('Holdings UI: existing order array → click ↓ on row 2 → row 2 swaps with row 3', async ({ page }) => {
  // Order array pre-materialized in insertion order.
  await page.addInitScript(INIT_SCRIPT);
  await gotoHoldingsPage(page);

  // Click ↓ on row 2 (GOOG / h-2).
  await page.click('[data-testid="holdings-move-down-h-2"]');

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings_order && d.holdings_order[1] === 'h-3';
    },
    { timeout: 5000 }
  );

  const order = await readStoredOrder(page, 'holdings_order');
  expect(order).toEqual(['h-1', 'h-3', 'h-2']);

  // Table reflects the swap.
  expect(await readRenderedHoldingsOrder(page)).toEqual(['AAPL', 'MSFT', 'GOOG']);
});

test('Holdings UI: top row ↑ button is disabled, bottom row ↓ button is disabled', async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT);
  await gotoHoldingsPage(page);

  // Top row (h-1): ↑ disabled, ↓ enabled.
  await expect(page.locator('[data-testid="holdings-move-up-h-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="holdings-move-down-h-1"]')).toBeEnabled();

  // Middle row (h-2): both enabled.
  await expect(page.locator('[data-testid="holdings-move-up-h-2"]')).toBeEnabled();
  await expect(page.locator('[data-testid="holdings-move-down-h-2"]')).toBeEnabled();

  // Bottom row (h-3): ↑ enabled, ↓ disabled.
  await expect(page.locator('[data-testid="holdings-move-up-h-3"]')).toBeEnabled();
  await expect(page.locator('[data-testid="holdings-move-down-h-3"]')).toBeDisabled();
});

test('Holdings UI: single holding → both ↑ and ↓ are disabled', async ({ page }) => {
  const singleFixture = {
    ...PORTFOLIO_FIXTURE,
    holdings: [PORTFOLIO_FIXTURE.holdings[0]],
    holdings_order: ['h-1'],
  };
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(singleFixture)}));
  `);
  await gotoHoldingsPage(page);

  await expect(page.locator('[data-testid="holdings-move-up-h-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="holdings-move-down-h-1"]')).toBeDisabled();
});

test('Holdings UI: add a new holding → it appears at the bottom of the table (manual order not violated)', async ({ page }) => {
  // Order array present. The add shim appends to the array (T01 wiring).
  await page.addInitScript(INIT_SCRIPT);
  await gotoHoldingsPage(page);

  // Add a new holding via the saveHolding shim.
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

  // Wait for the holdings list to grow to 4.
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings.length === 4 && Array.isArray(d.holdings_order)
          && d.holdings_order.length === 4;
    },
    { timeout: 5000 }
  );

  // The new id is appended to the order array (the T01 save shim appends).
  const order = await readStoredOrder(page, 'holdings_order');
  expect(order.slice(0, 3)).toEqual(['h-1', 'h-2', 'h-3']);
  const newId = order[3];

  // The new ticker 'NEW' is rendered at the bottom of the table.
  const rendered = await readRenderedHoldingsOrder(page);
  expect(rendered).toEqual(['AAPL', 'GOOG', 'MSFT', 'NEW']);

  // The new row has its own ↑/↓ buttons with the correct testid.
  await expect(page.locator(`[data-testid="holdings-move-up-${newId}"]`)).toBeEnabled();
  await expect(page.locator(`[data-testid="holdings-move-down-${newId}"]`)).toBeDisabled();
});

test('Holdings UI: delete a middle holding → table re-renders without it; array no longer references its id', async ({ page }) => {
  // Pre-materialized order array.
  await page.addInitScript(INIT_SCRIPT);
  await gotoHoldingsPage(page);

  // Auto-accept the confirm dialog for the delete.
  autoAcceptDialogs(page);

  // Delete h-2 via the shim (the per-row delete button uses the same shim).
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.removeHolding('h-2');
  });

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.holdings_order && d.holdings_order.indexOf('h-2') === -1
          && d.holdings.length === 2;
    },
    { timeout: 5000 }
  );

  const order = await readStoredOrder(page, 'holdings_order');
  expect(order).toEqual(['h-1', 'h-3']);

  // Table re-renders without GOOG.
  expect(await readRenderedHoldingsOrder(page)).toEqual(['AAPL', 'MSFT']);
});

// --- T03 scenarios --------------------------------------------------------
// T03 follows the same pattern as T02 but applies the Order column to
// the Cash and Debts tables on the Cash & Debts page. Each section
// maintains its own order array (cash_accounts_order / debts_order);
// cross-section independence is verified at the end.

// Cash fixture: 3 accounts with a pre-populated cash_accounts_order array.
const CASH_FIXTURE = {
  ...PORTFOLIO_FIXTURE,
  // Re-declare so the spread doesn't merge arrays under different keys.
  cash_accounts: [
    { id: 'c-1', name: 'Checking', balance: 1000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'c-2', name: 'Savings', balance: 5000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'c-3', name: 'Brokerage', balance: 2500, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
  ],
  cash_accounts_order: ['c-1', 'c-2', 'c-3'],
  debts: [
    { id: 'd-1', name: 'Credit card', balance: 2000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'd-2', name: 'Mortgage', balance: 8000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
    { id: 'd-3', name: 'Car loan', balance: 4000, currency: 'TWD',
      attributes: {}, updated_at: '2025-01-01T00:00:00.000Z',
      device_id: 'smoke', inactive: false },
  ],
  debts_order: ['d-1', 'd-2', 'd-3'],
};

test('Cash: no order array → click ↓ on row 1 → row 1 swaps with row 2, array materializes', async ({ page }) => {
  // No cash_accounts_order yet — user has never reordered cash.
  const fixture = { ...CASH_FIXTURE };
  delete fixture.cash_accounts_order;
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await gotoCashDebtPage(page);

  // Confirm initial state: array absent, table renders in insertion order.
  expect(await readStoredOrder(page, 'cash_accounts_order')).toBeUndefined();
  expect(await readRenderedCashOrder(page)).toEqual(['Checking', 'Savings', 'Brokerage']);

  // Click ↓ on row 1 (c-1 / Checking).
  await page.click('[data-testid="cash-move-down-c-1"]');

  // Wait for save to localStorage.
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return Array.isArray(d.cash_accounts_order) && d.cash_accounts_order[0] === 'c-2';
    },
    { timeout: 5000 }
  );

  // Order array materialized with c-1 at position 1 (after c-2).
  const order = await readStoredOrder(page, 'cash_accounts_order');
  expect(order).toEqual(['c-2', 'c-1', 'c-3']);

  // Table re-renders with Savings at the top.
  expect(await readRenderedCashOrder(page)).toEqual(['Savings', 'Checking', 'Brokerage']);
});

test('Cash: existing array → click ↑ on row 3 → row 3 swaps with row 2', async ({ page }) => {
  // Order array pre-materialized in insertion order.
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(CASH_FIXTURE)}));
  `);
  await gotoCashDebtPage(page);

  // Click ↑ on row 3 (Brokerage / c-3).
  await page.click('[data-testid="cash-move-up-c-3"]');

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.cash_accounts_order && d.cash_accounts_order[1] === 'c-3';
    },
    { timeout: 5000 }
  );

  const order = await readStoredOrder(page, 'cash_accounts_order');
  expect(order).toEqual(['c-1', 'c-3', 'c-2']);

  // Table reflects the swap.
  expect(await readRenderedCashOrder(page)).toEqual(['Checking', 'Brokerage', 'Savings']);
});

test('Cash: top row ↑ disabled; bottom row ↓ disabled; single row both disabled', async ({ page }) => {
  // NOTE: We don't use addInitScript here because the single-row variant
  // needs to mutate localStorage mid-test + reload, and addInitScript
  // re-runs on every navigation, clobbering the mutation. Instead, seed
  // localStorage via evaluate AFTER the first navigation, then reload —
  // localStorage persists across reloads without re-seeding. Same pattern
  // as T02's `holdings_order: persists across page reload` test.
  autoAcceptDialogs(page);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.evaluate((fixture) => {
    localStorage.setItem('property_tracker_portfolio_v1', JSON.stringify(fixture));
  }, CASH_FIXTURE);
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'cash_debt';
  });
  await page.waitForSelector('[data-testid="cash-move-up-c-1"]', { state: 'attached' });

  // Top row (c-1): ↑ disabled, ↓ enabled.
  await expect(page.locator('[data-testid="cash-move-up-c-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="cash-move-down-c-1"]')).toBeEnabled();

  // Middle row (c-2): both enabled.
  await expect(page.locator('[data-testid="cash-move-up-c-2"]')).toBeEnabled();
  await expect(page.locator('[data-testid="cash-move-down-c-2"]')).toBeEnabled();

  // Bottom row (c-3): ↑ enabled, ↓ disabled.
  await expect(page.locator('[data-testid="cash-move-up-c-3"]')).toBeEnabled();
  await expect(page.locator('[data-testid="cash-move-down-c-3"]')).toBeDisabled();

  // Single-row check: collapse cash to 1 account, both buttons disabled.
  const singleCash = {
    ...CASH_FIXTURE,
    cash_accounts: [CASH_FIXTURE.cash_accounts[0]],
    cash_accounts_order: ['c-1'],
  };
  await page.evaluate((single) => {
    localStorage.setItem('property_tracker_portfolio_v1', JSON.stringify(single));
  }, singleCash);
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'cash_debt';
  });
  await page.waitForSelector('[data-testid="cash-move-up-c-1"]', { state: 'attached' });

  await expect(page.locator('[data-testid="cash-move-up-c-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="cash-move-down-c-1"]')).toBeDisabled();
});

test('Debts: no order array → click ↓ on row 1 → row 1 swaps with row 2, array materializes', async ({ page }) => {
  // No debts_order yet — user has never reordered debts.
  const fixture = { ...CASH_FIXTURE };
  delete fixture.debts_order;
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `);
  await gotoCashDebtPage(page);

  expect(await readStoredOrder(page, 'debts_order')).toBeUndefined();
  expect(await readRenderedDebtsOrder(page)).toEqual(['Credit card', 'Mortgage', 'Car loan']);

  // Click ↓ on row 1 (d-1 / Credit card).
  await page.click('[data-testid="debts-move-down-d-1"]');

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return Array.isArray(d.debts_order) && d.debts_order[0] === 'd-2';
    },
    { timeout: 5000 }
  );

  const order = await readStoredOrder(page, 'debts_order');
  expect(order).toEqual(['d-2', 'd-1', 'd-3']);

  expect(await readRenderedDebtsOrder(page)).toEqual(['Mortgage', 'Credit card', 'Car loan']);
});

test('Debts: existing array → click ↑ on row 3 → row 3 swaps with row 2', async ({ page }) => {
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(CASH_FIXTURE)}));
  `);
  await gotoCashDebtPage(page);

  // Click ↑ on row 3 (Car loan / d-3).
  await page.click('[data-testid="debts-move-up-d-3"]');

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.debts_order && d.debts_order[1] === 'd-3';
    },
    { timeout: 5000 }
  );

  const order = await readStoredOrder(page, 'debts_order');
  expect(order).toEqual(['d-1', 'd-3', 'd-2']);

  expect(await readRenderedDebtsOrder(page)).toEqual(['Credit card', 'Car loan', 'Mortgage']);
});

test('Debts: top row ↑ disabled; bottom row ↓ disabled; single row both disabled', async ({ page }) => {
  // NOTE: Same pattern as Cash test — use evaluate/mutate-then-reload
  // instead of addInitScript to avoid clobbering the single-row mutation.
  autoAcceptDialogs(page);
  await page.goto('http://localhost:8000/portfolio.html');
  await page.evaluate((fixture) => {
    localStorage.setItem('property_tracker_portfolio_v1', JSON.stringify(fixture));
  }, CASH_FIXTURE);
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'cash_debt';
  });
  await page.waitForSelector('[data-testid="debts-move-up-d-1"]', { state: 'attached' });

  // Top row (d-1): ↑ disabled, ↓ enabled.
  await expect(page.locator('[data-testid="debts-move-up-d-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="debts-move-down-d-1"]')).toBeEnabled();

  // Middle row (d-2): both enabled.
  await expect(page.locator('[data-testid="debts-move-up-d-2"]')).toBeEnabled();
  await expect(page.locator('[data-testid="debts-move-down-d-2"]')).toBeEnabled();

  // Bottom row (d-3): ↑ enabled, ↓ disabled.
  await expect(page.locator('[data-testid="debts-move-up-d-3"]')).toBeEnabled();
  await expect(page.locator('[data-testid="debts-move-down-d-3"]')).toBeDisabled();

  // Single-row check: collapse debts to 1 entry, both buttons disabled.
  const singleDebt = {
    ...CASH_FIXTURE,
    debts: [CASH_FIXTURE.debts[0]],
    debts_order: ['d-1'],
  };
  await page.evaluate((single) => {
    localStorage.setItem('property_tracker_portfolio_v1', JSON.stringify(single));
  }, singleDebt);
  await page.reload();
  await page.waitForFunction(() => !!window.Alpine);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.currentPage = 'cash_debt';
  });
  await page.waitForSelector('[data-testid="debts-move-up-d-1"]', { state: 'attached' });

  await expect(page.locator('[data-testid="debts-move-up-d-1"]')).toBeDisabled();
  await expect(page.locator('[data-testid="debts-move-down-d-1"]')).toBeDisabled();
});

test('Cash & Debts: cross-section independence \u2014 reordering cash does NOT change debt order', async ({ page }) => {
  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(CASH_FIXTURE)}));
  `);
  await gotoCashDebtPage(page);

  // Swap cash row 1 down.
  await page.click('[data-testid="cash-move-down-c-1"]');
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.cash_accounts_order && d.cash_accounts_order[0] === 'c-2';
    },
    { timeout: 5000 }
  );

  // Cash array changed.
  const cashOrder = await readStoredOrder(page, 'cash_accounts_order');
  expect(cashOrder).toEqual(['c-2', 'c-1', 'c-3']);

  // Debts array unchanged (cross-section independence).
  const debtOrder = await readStoredOrder(page, 'debts_order');
  expect(debtOrder).toEqual(['d-1', 'd-2', 'd-3']);

  // Conversely, swap a debt row up and verify cash is untouched.
  await page.click('[data-testid="debts-move-up-d-3"]');
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('property_tracker_portfolio_v1');
      if (!raw) return false;
      const d = JSON.parse(raw);
      return d.debts_order && d.debts_order[1] === 'd-3';
    },
    { timeout: 5000 }
  );

  // Debts array changed.
  const debtOrder2 = await readStoredOrder(page, 'debts_order');
  expect(debtOrder2).toEqual(['d-1', 'd-3', 'd-2']);

  // Cash array still at the post-first-swap state (untouched by the 2nd swap).
  const cashOrder2 = await readStoredOrder(page, 'cash_accounts_order');
  expect(cashOrder2).toEqual(['c-2', 'c-1', 'c-3']);
});
