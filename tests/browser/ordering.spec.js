// tests/browser/ordering.spec.js — Playwright browser smoke for the
// v1.6 record-ordering data model + mechanical wiring (ticket 01).
// Run via stage 4 of ./scripts/safety-net.sh.
//
// What it covers (ticket 01 / spec §Mechanical wiring):
//   - Pre-existing holdings_order: delete a holding via the shim strips
//     its id from the matching order array.
//   - Pre-existing holdings_order: refresh the page after delete → order
//     array still clean (no stale id).
//   - Pre-existing cash_accounts_order + debts_order: same coverage
//     (cross-collection independence — reordering one collection does
//     not affect the others).
//   - Add a new holding when order array absent → order array stays
//     absent (lazy-write preserved).
//
// Non-goals (covered by T02 / T03):
//   - ↑/↓ button rendering, disabled states, lazy-write materialize
//     on first click.
//
// Wiring:
//   - Fixture is injected via page.addInitScript into localStorage
//     under the key 'property_tracker_portfolio_v1'.
//   - The delete / add paths use Alpine shim methods
//     (window.Alpine.$data(root).removeHolding / saveHolding etc.) to
//     avoid depending on the T02/T03 button selectors.

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
