// tests/browser/holdings-currency.spec.js — Playwright browser smoke for
// v1.14 act-vs-measure: per-share stock facts (cost/share, price/share,
// 52w range) stay in the holding's listing currency regardless of the
// displayCurrency toggle. Position-level fields (value, gain/loss) and
// cash/debt balances continue to roll up into displayCurrency so the
// net-worth aggregate stays consistent.
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright
// owns its own test discovery under playwright.config.ts testDir).
//
// What it covers (per .scratch/v1.14-act-vs-measure/issues/01):
//   - Holdings page USD holding: cost, price, 52w stay USD across toggle.
//   - Holdings page USD holding: value, gain/loss still convert (regression).
//   - Holdings page TWD holding: cost, price, 52w stay TWD across toggle.
//   - Snapshot detail holdings USD holding: cost, price stay USD across toggle.
//
// ADR 0017 §6 establishes the per-record native / aggregate baseline rule
// for the Rebalance page. This spec extends that rule cross-cuttingly.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Fixture: one USD holding (cost $40, current_price $50 → gain $100)
// and one TWD holding (cost 1500, current_price 1800 → gain 30000).
// 52w low/high chosen so they fall within the K/M and Y/W full-format
// bands under each currency. fx_rate: 32.
const PORTFOLIO_FIXTURE = {
  version: '1.1',
  holdings: [
    {
      id: 'h-usd',
      ticker: 'AAPL',
      shares: 10,
      cost: 40,
      currency: 'USD',
      current_price: 50,
      low_52w: 35,
      high_52w: 55,
      prev_close: 50,
      inactive: false,
      attributes: {},
    },
    {
      id: 'h-twd',
      ticker: '2330.TW',
      shares: 100,
      cost: 1500,
      currency: 'TWD',
      current_price: 1800,
      low_52w: 1200,
      high_52w: 2000,
      prev_close: 1800,
      inactive: false,
      attributes: {},
    },
  ],
  cash_accounts: [],
  debts: [],
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
    fx_rate: 32,
    snapshot_cap: 365,
  },
  meta: {
    device_id: 'act-vs-measure-smoke-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

const INIT_SCRIPT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(PORTFOLIO_FIXTURE)}));
window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
`;

function isNoise(msg) {
  const text = msg.text();
  if (/Failed to load resource/i.test(text) && (msg.location()?.url || '').endsWith('favicon.ico')) return true;
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

async function setDisplayCurrency(page, currency) {
  await page.evaluate((c) => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.setCurrency(c);
  }, currency);
  // Let Alpine re-render.
  await page.waitForTimeout(50);
}

// Find the desktop table row for a given holding id. The row contains
// `data-testid="holdings-move-up-<id>"` so we anchor via `:has`.
function rowLocator(page, id) {
  return page.locator(`tr:has([data-testid="holdings-move-up-${id}"])`);
}

// Cell text by column index. Holdings table column order:
//   1: order (↑/↓), 2: ticker, 3: shares, 4: cost/share, 5: price/share,
//   6: day Δ%, 7: 52w range, 8: value, 9: gain/loss, 10: actions
async function cellText(row, n) {
  return (await row.locator(`td:nth-child(${n})`).innerText()).trim();
}

test.describe('act-vs-measure (v1.14): per-share stock facts stay in listing currency', () => {
  test.beforeEach(async ({ page }) => {
    // Set desktop viewport so the table is visible (≥md).
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(INIT_SCRIPT);
  });

  test('Holdings page — USD holding: cost, price, 52w stay USD across TWD/USD toggle', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.evaluate(() => {
      window.Alpine.$data(document.querySelector('[x-data]')).currentPage = 'holdings';
    });
    const row = rowLocator(page, 'h-usd');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // TWD baseline — capture per-share fields.
    const twdCost = await cellText(row, 4);
    const twdPrice = await cellText(row, 5);
    const twdWeek52 = await cellText(row, 7);

    // Toggle to USD and re-capture.
    await setDisplayCurrency(page, 'USD');
    const usdCost = await cellText(row, 4);
    const usdPrice = await cellText(row, 5);
    const usdWeek52 = await cellText(row, 7);

    // Native: per-share fields are identical regardless of toggle.
    expect(usdCost, 'cost/share stays USD').toBe(twdCost);
    expect(usdPrice, 'price/share stays USD').toBe(twdPrice);
    expect(usdWeek52, '52w range stays USD').toBe(twdWeek52);

    // Sanity: no TWD-style W/Y suffix on USD-rendered values.
    expect(usdCost).not.toMatch(/[WY]/);
    expect(usdPrice).not.toMatch(/[WY]/);
    expect(usdWeek52).not.toMatch(/[WY]/);
    // Sanity: at least one of them is non-empty.
    expect(usdCost).toMatch(/\$/);
    expect(usdPrice).toMatch(/\$/);
    expect(usdWeek52).toMatch(/\$/);

    expect(errors).toEqual([]);
  });

  test('Holdings page — USD holding: value, gain/loss still convert with toggle (regression)', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.evaluate(() => {
      window.Alpine.$data(document.querySelector('[x-data]')).currentPage = 'holdings';
    });
    const row = rowLocator(page, 'h-usd');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // TWD baseline — capture position-level totals.
    const twdValue = await cellText(row, 8);
    const twdGainLoss = await cellText(row, 9);

    // Toggle to USD.
    await setDisplayCurrency(page, 'USD');
    const usdValue = await cellText(row, 8);
    const usdGainLoss = await cellText(row, 9);

    // Position-level totals DO convert; toggle must change the text.
    expect(usdValue, 'value cell changes with displayCurrency').not.toBe(twdValue);
    expect(usdGainLoss, 'gain/loss cell changes with displayCurrency').not.toBe(twdGainLoss);

    // Sanity: TWD baseline shows the converted value (with W/Y suffix for ≥10K).
    // 10 shares × $50 = $500 USD → $16,000 TWD → ≥10K → W → "$1.60W".
    expect(twdValue).toContain('1.60W');
    // Sanity: USD baseline shows the native USD value: $500.00 (<1K → full).
    expect(usdValue).toContain('$500.00');
    // Sanity: gain/loss differs in sign too — TWD $3,200.00 vs USD $100.00.
    expect(twdGainLoss).toContain('$3,200.00');
    expect(usdGainLoss).toContain('$100.00');

    expect(errors).toEqual([]);
  });

  test('Holdings page — TWD holding: cost, price, 52w stay TWD across TWD/USD toggle', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.goto('http://localhost:8000/portfolio.html');
    await page.evaluate(() => {
      window.Alpine.$data(document.querySelector('[x-data]')).currentPage = 'holdings';
    });
    const row = rowLocator(page, 'h-twd');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // TWD baseline — capture per-share fields.
    const twdCost = await cellText(row, 4);
    const twdPrice = await cellText(row, 5);
    const twdWeek52 = await cellText(row, 7);

    // Toggle to USD.
    await setDisplayCurrency(page, 'USD');
    const usdCost = await cellText(row, 4);
    const usdPrice = await cellText(row, 5);
    const usdWeek52 = await cellText(row, 7);

    // Native: TWD holding's per-share fields are identical regardless of toggle.
    expect(usdCost, 'cost/share stays TWD').toBe(twdCost);
    expect(usdPrice, 'price/share stays TWD').toBe(twdPrice);
    expect(usdWeek52, '52w range stays TWD').toBe(twdWeek52);

    // Sanity: TWD values include the native currency formatting.
    expect(twdCost).toContain('$');
    expect(twdPrice).toContain('$');
    expect(twdWeek52).toContain('$');

    expect(errors).toEqual([]);
  });

  test('Snapshot detail holdings — USD holding: cost, price stay USD across toggle', async ({ page }) => {
    const errors = collectAppErrors(page);
    // Auto-accept confirm dialogs (snapshot taking triggers intraday warning).
    page.on('dialog', async (d) => { await d.accept(); });

    await page.goto('http://localhost:8000/portfolio.html');
    // Take a snapshot via the empty-state CTA, then view detail.
    await page.locator('[data-testid="nav-snapshots"]').click();
    await expect(page.locator('[data-testid="snapshot-empty"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="snapshot-empty-take"]').click();
    await expect(page.locator('[data-testid="snapshot-row"]')).toHaveCount(1);
    await page.locator('[data-testid="snapshot-row-view"]').first().click();
    await expect(page.locator('[data-testid="snapshot-detail"]')).toBeVisible({ timeout: 5_000 });

    // Snapshot detail holdings table — column order:
    //   1: ticker+attributes, 2: shares, 3: cost, 4: price, 5: value, 6: gainLoss
    // Filter out the empty-placeholder row (has its own data-testid).
    const detailTable = page.locator('[data-testid="snapshot-detail-holdings-table"]');
    const detailRows = detailTable.locator('tbody tr:not([data-testid])');
    await expect(detailRows).toHaveCount(2);
    // h-usd is first in fixture (no holdings_order → array order).
    const usdRow = detailRows.first();

    async function detailCell(row, n) {
      return (await row.locator(`td:nth-child(${n})`).innerText()).trim();
    }

    // TWD baseline.
    const twdCost = await detailCell(usdRow, 3);
    const twdPrice = await detailCell(usdRow, 4);

    // Toggle to USD.
    await setDisplayCurrency(page, 'USD');
    const usdCost = await detailCell(usdRow, 3);
    const usdPrice = await detailCell(usdRow, 4);

    // Native: cost/share and price/share identical regardless of toggle.
    expect(usdCost, 'snapshot detail cost stays USD').toBe(twdCost);
    expect(usdPrice, 'snapshot detail price stays USD').toBe(twdPrice);

    // Sanity: no TWD-style suffix on USD values.
    expect(usdCost).not.toMatch(/[WY]/);
    expect(usdPrice).not.toMatch(/[WY]/);

    expect(errors).toEqual([]);
  });
});
