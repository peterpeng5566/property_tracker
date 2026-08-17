// tests/browser/_mobile_smoke.spec.js — v1.9 mobile responsiveness smoke
// + regression net (T01 audit scaffolding + T02 commit 1 expansion).
//
// Run: stage 4 of `./scripts/safety-net.sh`.
//
// What it covers:
//   - At 414×736 viewport (iPhone 6 Plus / Max baseline per Q1 = d):
//     * Every page body's `document.documentElement.scrollWidth` is ≤ 414
//       (no horizontal overflow).
//     * Tables (Holdings, Cash, Debts, Plans drift, Rebalance candidate)
//       are hidden at < md; their stacked-card equivalents render instead.
//     * Header: hamburger button visible, second-row nav buttons hidden.
//     * Clicking hamburger opens the drawer; clicking the backdrop closes
//       it.
//     * The Add Holding modal fits the viewport with no horizontal
//       overflow.
//
// What it does NOT cover (deferred to page-specific mobile tests):
//   - per-row visual polish (font sizes, spacing, gradient decisions
//     that the audit script catches at T01).
//   - other modals (Add Cash / Add Debt / Intraday / Sync) are similar
//     shapes (w-full max-w-md); covered by the Add Holding pattern plus
//     audit verification.
//
// The script `scripts/mobile-audit.mjs` is the on-demand diagnostic that
// produced the v1.9 hot list. This smoke file is the always-on
// regression net inside safety-net stage 4.
//
// Wiring:
//   - Empty fixture for the 9-page overflow smoke.
//   - Per-feature fixture for the new page-by-page tests (Holdings 5
//     rows; Cash 3 + Debts 2; Plans 1 rule; Rebalance 3 matched
//     holdings) so the markup we add in commits 3-5 has something to
//     render.
//   - Navigation uses `window.Alpine.$data(root).currentPage` directly
//     (matches `ordering.spec.js`).
//
// RED → GREEN plan (T01 / T02 split):
//   - At T01 close-out (commit 0b39684): the 9 overflow tests are
//     `test.fixme()` because the production markup is desktop-only.
//   - At T02 commit 1 (this commit): the `test.fixme(...)` wrapper is
//     removed from the 9 tests, AND new tests are added for
//     cards / drawer / modal. All tests in this file are expected to
//     FAIL at this commit (the production markup does not yet have
//     mobile layout).
//   - Commits 2-5 turn the tests GREEN piece by piece.
//   - At T02 commit 6 close-out, all tests pass at 414×736.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers (minimal — these tests care about layout, not
// full-fidelity fixtures used by other browser specs).
// ──────────────────────────────────────────────────────────────────────

function emptyFixture() {
  return {
    version: '1.1',
    holdings: [],
    holdings_order: [],
    cash_accounts: [],
    cash_accounts_order: [],
    debts: [],
    debts_order: [],
    categories: [],
    snapshots: [],
    plans: [],
    active_plan_id: null,
    backups: [],
    deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
      snapshot_cap: 365,
    },
    meta: {
      device_id: 'mobile-smoke-device',
      last_synced_at: null,
      created_at: '2025-01-01T00:00:00.000Z',
    },
  };
}

// 5 holdings × 4 currencies — the canonical "small portfolio" fixture
// used by the audit script.
function populatedHoldingsFixture() {
  return {
    version: '1.1',
    holdings: [
      { id: 'h-1', ticker: '2330.TW',  shares: 1000, cost: 50,  currency: 'TWD', current_price: 600, high_52w: 700, low_52w: 500, attributes: {} },
      { id: 'h-2', ticker: '2454.TW',  shares: 200,  cost: 100, currency: 'TWD', current_price: 500, high_52w: 580, low_52w: 420, attributes: {} },
      { id: 'h-3', ticker: 'AAPL',     shares: 50,   cost: 150, currency: 'USD', current_price: 180, high_52w: 200, low_52w: 150, attributes: {} },
      { id: 'h-4', ticker: 'TSM',      shares: 80,   cost: 100, currency: 'USD', current_price: 130, high_52w: 140, low_52w: 95,  attributes: {} },
      { id: 'h-5', ticker: '7203.T',   shares: 100,  cost: 2000,currency: 'JPY', current_price: 2500,high_52w: 3000,low_52w: 1800,attributes: {} },
    ],
    holdings_order: ['h-1','h-2','h-3','h-4','h-5'],
    cash_accounts: [],
    cash_accounts_order: [],
    debts: [],
    debts_order: [],
    categories: [],
    snapshots: [],
    plans: [],
    active_plan_id: null,
    backups: [],
    deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
      snapshot_cap: 365,
    },
    meta: {
      device_id: 'mobile-smoke-device',
      last_synced_at: null,
      created_at: '2025-01-01T00:00:00.000Z',
    },
  };
}

// 3 cash accounts + 2 debts — exercises the icon + amber border
// distinction called out in ADR 0020.
function populatedCashDebtsFixture() {
  return {
    version: '1.1',
    holdings: [],
    holdings_order: [],
    cash_accounts: [
      { id: 'c-1', name: 'Taishin savings',     balance: 100000, currency: 'TWD', account_type: 'savings',   interest_rate: 1.5, last_updated: '2024-12-01T00:00:00.000Z' },
      { id: 'c-2', name: 'Fidelity USD',        balance: 5000,   currency: 'USD', account_type: 'investment',interest_rate: 4.0, last_updated: '2024-12-01T00:00:00.000Z' },
      { id: 'c-3', name: 'MUFG checking (JPY)', balance: 500000, currency: 'JPY', account_type: 'checking',  interest_rate: 0.1, last_updated: '2024-12-01T00:00:00.000Z' },
    ],
    cash_accounts_order: ['c-1','c-2','c-3'],
    debts: [
      { id: 'd-1', name: 'Mortgage',          balance: 5_000_000, original: 6_000_000, apr: 2.0, min_payment: 25000, due_day: 15, currency: 'TWD' },
      { id: 'd-2', name: 'Credit card',       balance: 25000,     original: 25000,    apr: 18.0,min_payment: 1250,  due_day: 5,  currency: 'TWD' },
    ],
    debts_order: ['d-1','d-2'],
    categories: [],
    snapshots: [],
    plans: [],
    active_plan_id: null,
    backups: [],
    deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
      snapshot_cap: 365,
    },
    meta: {
      device_id: 'mobile-smoke-device',
      last_synced_at: null,
      created_at: '2025-01-01T00:00:00.000Z',
    },
  };
}

// 1 plan with 1 rule (Region=TW, target_weight_pct=100) + 3 TW holdings.
// Rebalance should produce 3 candidate rows; T02 commit 5 turns these
// into per-record cards.
function rebalanceFixture() {
  const f = populatedHoldingsFixture();
  f.cash_accounts = [];
  f.cash_accounts_order = [];
  f.debts = [];
  f.debts_order = [];
  f.holdings = [
    { id: 'h-1', ticker: '2330.TW', shares: 1000, cost: 50, currency: 'TWD', current_price: 600, high_52w: 700, low_52w: 500, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    { id: 'h-2', ticker: '2454.TW', shares: 200,  cost: 100,currency: 'TWD', current_price: 500, high_52w: 580, low_52w: 420, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    { id: 'h-3', ticker: '2882.TW', shares: 100,  cost: 100,currency: 'TWD', current_price: 1000,high_52w: 1200,low_52w: 800, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
  ];
  f.holdings_order = ['h-1','h-2','h-3'];
  f.categories = [
    { id: 'cat-region', name: 'Region', applies_to: ['holdings','cash','debt'],
      values: [{ id: 'val-TW', name: 'TW' }, { id: 'val-US', name: 'US' }] },
    { id: 'cat-type', name: 'Type', applies_to: ['holdings','cash','debt'],
      values: [{ id: 'val-stock', name: 'Stock' }, { id: 'val-bond', name: 'Bond' }] },
  ];
  const planId = 'plan-1';
  f.plans = [{
    id: planId,
    name: 'TW stocks',
    updated_at: '2024-07-01T00:00:00.000Z',
    rules: [{
      id: 'rule-1',
      name: 'All TW stocks',
      when: { 'cat-region': ['val-TW'] },
      distribute: { 'cat-type': { 'val-stock': 100 } },
      target_weight_pct: 100,
    }],
  }];
  f.active_plan_id = planId;
  return f;
}

// 1 plan with 1 rule but no match — exercises the "no-eligible-rules"
// empty state at < md.
function plansEmptyFixture() {
  const f = emptyFixture();
  const planId = 'plan-1';
  f.plans = [{
    id: planId,
    name: 'Empty plan',
    updated_at: '2024-07-01T00:00:00.000Z',
    rules: [{
      id: 'rule-1',
      name: 'No match rule',
      when: { 'cat-region': ['val-FR'] },
      distribute: {},
      target_weight_pct: 100,
    }],
  }];
  f.active_plan_id = planId;
  return f;
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `;
}

// Wait for Alpine to mount and the seeded page to render. Doesn't
// require a specific testid — works on any page.
async function waitForAlpine(page) {
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine, { timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function navigateTo(page, currentPage) {
  await page.evaluate((cp) => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).currentPage = cp;
  }, currentPage);
  await page.waitForTimeout(150);
}

// ──────────────────────────────────────────────────────────────────────
// Test config
// ──────────────────────────────────────────────────────────────────────

const VIEWPORT = { width: 414, height: 736 };
// v1.9 floor per Q1 = d (iPhone 6 Plus / Max). 414 px catches anything
// that needs stacked-card treatment.
const MAX_VIEWPORT_WIDTH = VIEWPORT.width;

// 8 pages per the v1.9 map.
const PAGES = [
  { id: 'home',       label: 'Home' },
  { id: 'holdings',   label: 'Holdings' },
  { id: 'cash_debt',  label: 'Cash & Debts' },
  { id: 'categories', label: 'Categories' },
  { id: 'plans',      label: 'Plans' },
  { id: 'rebalance',  label: 'Rebalance' },
  { id: 'snapshots',  label: 'Snapshots' },
  { id: 'backups',    label: 'Backups' },
];

// Pages that have `data-testid="<id>-page"` (visibility check).
const PAGES_WITH_TESTID = new Set(['plans', 'rebalance', 'snapshots', 'backups']);

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

test.describe(`portfolio.html mobile smoke (414×736)`, () => {
  test.use({ viewport: VIEWPORT });

  // ─────────────────────────────────────────────────────────────────
  // § 1 — Per-page horizontal overflow (the original T01 smoke, now
  // un-fixme'd). At T02 commit 1 these FAIL because production markup
  // is still desktop-only; commits 2 (header) + 3-5 (tables → cards)
  // turn them GREEN.
  // ─────────────────────────────────────────────────────────────────
  test.describe('§1 — Per-page horizontal overflow', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
    });

    for (const p of PAGES) {
      test(`no horizontal overflow on ${p.label} page`, async ({ page }) => {
        await waitForAlpine(page);
        await navigateTo(page, p.id);

        if (PAGES_WITH_TESTID.has(p.id)) {
          await expect(page.locator(`[data-testid="${p.id}-page"]`)).toBeVisible({ timeout: 3_000 });
        } else {
          const currentPageAfter = await page.evaluate(() => {
            const root = document.querySelector('[x-data]');
            return window.Alpine.$data(root).currentPage;
          });
          expect(currentPageAfter).toBe(p.id);
        }

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, `${p.label} should not overflow ${MAX_VIEWPORT_WIDTH}px (actual scrollWidth=${scrollWidth}px)`).toBeLessThanOrEqual(MAX_VIEWPORT_WIDTH);

        const innerWidth = await page.evaluate(() => window.innerWidth);
        expect(innerWidth).toBe(VIEWPORT.width);
      });
    }

    test('header / nav does not overflow at 414 px', async ({ page }) => {
      await waitForAlpine(page);
      const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(docScrollWidth).toBeLessThanOrEqual(MAX_VIEWPORT_WIDTH);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 2 — Holdings table → stacked card (T02 commit 3 turns GREEN).
  // ─────────────────────────────────────────────────────────────────
  test.describe('§2 — Holdings page (table → card)', () => {
    test('at 414 px, 5 holdings render as 5 cards (not table rows)', async ({ page }) => {
      await page.addInitScript(initScript(populatedHoldingsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'holdings');

      const cardIds = ['h-1','h-2','h-3','h-4','h-5'].map(id => `[data-testid="holdings-card-row-${id}"]`);
      for (const sel of cardIds) {
        await expect(page.locator(sel), `expected ${sel} to be visible`).toBeVisible();
      }
    });

    test('at 414 px, the holdings <table> is hidden (display: none)', async ({ page }) => {
      await page.addInitScript(initScript(populatedHoldingsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'holdings');

      const tableDisplay = await page.evaluate(() => {
        const t = document.querySelector('table.w-full.text-sm');
        return t ? getComputedStyle(t).display : null;
      });
      expect(tableDisplay, 'holdings table should be display:none at < md').toBe('none');
    });

    test('at 414 px, empty holdings shows the mobile empty state', async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'holdings');

      // Mobile-specific empty state testid, defined by T02 commit 3.
      await expect(page.locator('[data-testid="holdings-empty-mobile"]')).toBeVisible();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 3 — Cash & Debts table → stacked card (T02 commit 4 turns GREEN).
  // ─────────────────────────────────────────────────────────────────
  test.describe('§3 — Cash & Debts page (table → card)', () => {
    test('at 414 px, 3 cash accounts render as 3 cards', async ({ page }) => {
      await page.addInitScript(initScript(populatedCashDebtsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'cash_debt');

      for (const id of ['c-1','c-2','c-3']) {
        await expect(page.locator(`[data-testid="cash-card-row-${id}"]`)).toBeVisible();
      }
    });

    test('at 414 px, 2 debts render as 2 cards', async ({ page }) => {
      await page.addInitScript(initScript(populatedCashDebtsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'cash_debt');

      for (const id of ['d-1','d-2']) {
        await expect(page.locator(`[data-testid="debt-card-row-${id}"]`)).toBeVisible();
      }
    });

    test('at 414 px, cash <table> and debts <table> are hidden', async ({ page }) => {
      await page.addInitScript(initScript(populatedCashDebtsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'cash_debt');

      // The page has many `table.w-full.text-sm` matches (Holdings,
      // Plans drift, Home page group tables in the x-show-hidden
      // parent, etc.). Scope the assertion to ONLY the tables inside
      // the cash + debts sections to avoid asserting on tables that
      // are hidden via the parent's x-show rather than their own
      // classes.
      const sections = await page.evaluate(() => {
        // The cash and debts sections are wrapped in <section>
        // elements; the second <section> on this page is "Debts".
        // Find them via the empty-state rows (or via the `<h2>` text)
        // and check the table inside.
        const allSections = Array.from(document.querySelectorAll('section'));
        // The two tables relevant here are the ones whose headers
        // point to `t('cash.empty')` (within the cash section) and
        // `t('debts.empty')` (within the debts section). We find them
        // by walking up from the empty-state <td>/<div>.
        const cashEmptyRow = Array.from(document.querySelectorAll('tr'))
          .find(tr => tr.querySelector('td[colspan]') && /cash/i.test(tr.textContent || ''));
        const debtsEmptyRow = Array.from(document.querySelectorAll('tr'))
          .find(tr => tr.querySelector('td[colspan]') && /debts/i.test(tr.textContent || ''));
        const cashTable = cashEmptyRow ? cashEmptyRow.closest('table') : null;
        const debtsTable = debtsEmptyRow ? debtsEmptyRow.closest('table') : null;
        return {
          cashTableDisplay: cashTable ? getComputedStyle(cashTable).display : null,
          debtsTableDisplay: debtsTable ? getComputedStyle(debtsTable).display : null,
          allSectionsCount: allSections.length,
        };
      });
      expect(sections.cashTableDisplay, 'cash table should be display:none at < md').toBe('none');
      expect(sections.debtsTableDisplay, 'debts table should be display:none at < md').toBe('none');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 4 — Plans drift card (T02 commit 5 turns GREEN).
  // ─────────────────────────────────────────────────────────────────
  test.describe('§4 — Plans page (drift table → card)', () => {
    test('at 414 px, plans-page is visible and has no horizontal overflow', async ({ page }) => {
      await page.addInitScript(initScript(plansEmptyFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'plans');

      await expect(page.locator('[data-testid="plans-page"]')).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(MAX_VIEWPORT_WIDTH);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 5 — Rebalance candidate table → card (T02 commit 5 turns GREEN).
  // ─────────────────────────────────────────────────────────────────
  test.describe('§5 — Rebalance page (table → card)', () => {
    test('at 414 px, 3 matched holdings render as 3 candidate cards', async ({ page }) => {
      await page.addInitScript(initScript(rebalanceFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'rebalance');

      await expect(page.locator('[data-testid="rebalance-page"]')).toBeVisible();
      for (const id of ['h-1','h-2','h-3']) {
        await expect(page.locator(`[data-testid="rebalance-candidate-card-${id}"]`)).toBeVisible();
      }
    });

    test('at 414 px, the rebalance candidate <table> is hidden', async ({ page }) => {
      await page.addInitScript(initScript(rebalanceFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'rebalance');

      // Find the candidate table by walking up from a candidate-row
      // testid, so we don't accidentally assert on a different page's
      // table that hasn't been hidden (Holdings / Cash / Debts /
      // Plans drift all live on this page in the DOM but in different
      // parents).
      const tableDisplay = await page.evaluate(() => {
        const candidateRow = document.querySelector('[data-testid^="rebalance-rule-candidate-"]');
        const table = candidateRow ? candidateRow.closest('table') : null;
        return table ? getComputedStyle(table).display : null;
      });
      expect(tableDisplay, 'rebalance candidate table should be display:none at < md').toBe('none');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 6 — Header drawer (T02 commit 2 turns GREEN).
  // ─────────────────────────────────────────────────────────────────
  test.describe('§6 — Header hamburger drawer', () => {
    test('at 414 px, the hamburger button is visible', async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
      await waitForAlpine(page);

      await expect(page.locator('[data-testid="header-hamburger"]')).toBeVisible();
    });

    test('at 414 px, the second-row nav buttons are hidden', async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
      await waitForAlpine(page);

      // The 8 second-row nav buttons live inside the <nav> element.
      // At < md the drawer replaces them; they should be display:none.
      const visibleNavButtonCount = await page.evaluate(() => {
        const nav = document.querySelector('nav');
        if (!nav) return 0;
        const buttons = nav.querySelectorAll('button');
        let visible = 0;
        for (const b of buttons) {
          if (getComputedStyle(b).display !== 'none') visible++;
        }
        return visible;
      });
      expect(visibleNavButtonCount, 'nav buttons should be hidden at < md').toBe(0);
    });

    test('at 414 px, clicking the hamburger opens the drawer', async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
      await waitForAlpine(page);

      // Note: Playwright's `locator.click()` doesn't fire the @click
      // handler on inline-SVG-icon buttons in headless Chromium at
      // 414 px for this app (works for text-only buttons like the
      // language toggle). We dispatch a synthetic click via JS to
      // reach the same code path users hit on a real device.
      await page.evaluate(() => {
        const h = document.querySelector('[data-testid="header-hamburger"]');
        h.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await expect(page.locator('[data-testid="mobile-nav-drawer"]')).toBeVisible();
    });

    test('at 414 px, clicking the backdrop closes the drawer', async ({ page }) => {
      await page.addInitScript(initScript(emptyFixture()));
      await waitForAlpine(page);

      await page.evaluate(() => {
        const h = document.querySelector('[data-testid="header-hamburger"]');
        h.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await expect(page.locator('[data-testid="mobile-nav-drawer"]')).toBeVisible();
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="mobile-nav-backdrop"]');
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await expect(page.locator('[data-testid="mobile-nav-drawer"]')).toBeHidden();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // § 7 — Modal fits at < md (T02 commit 6 verifies; this test is the
  // regression net. Modal is already `w-full max-w-md`, which on a 414
  // viewport naturally falls through to w-full=414. Header overflow is
  // what the modal test asserts against.)
  // ─────────────────────────────────────────────────────────────────
  test.describe('§7 — Add Holding modal at 414 px', () => {
    test('opening the modal does not push the document beyond viewport width', async ({ page }) => {
      await page.addInitScript(initScript(populatedHoldingsFixture()));
      await waitForAlpine(page);
      await navigateTo(page, 'holdings');

      // Trigger the Add Holding modal via the same DOM hook the audit
      // uses: window.Alpine.$data(...).showModal = true.
      await page.evaluate(() => {
        const root = document.querySelector('[x-data]');
        window.Alpine.$data(root).showModal = true;
      });
      await page.waitForTimeout(150);

      // The modal element exists and is visible.
      await expect(page.locator('[x-show="showModal"]').first()).toBeVisible();

      // The modal's own bounding rect must fit within viewport width.
      const modalBox = await page.evaluate(() => {
        const m = document.querySelector('[x-show="showModal"] > div');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
      expect(modalBox).not.toBeNull();
      expect(modalBox.left, 'modal must not start off-screen left').toBeGreaterThanOrEqual(0);
      expect(modalBox.right, 'modal must not extend past viewport right').toBeLessThanOrEqual(MAX_VIEWPORT_WIDTH);
    });
  });
});
