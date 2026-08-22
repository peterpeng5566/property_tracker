// tests/browser/summary-currency.spec.js — Playwright regression for the
// v1.18 bug: Home page summary cards (Net Worth, Holdings Value, Cash,
// Debts) showed incorrect values after toggling displayCurrency from TWD
// to USD. Root cause: the x-text templates used `this.displayCurrency`
// which in Alpine template scope resolves to window.displayCurrency
// (= undefined), causing formatAmount() to be called with src=undefined.
// toTWD(amount, undefined, fxRate) falls through to `return amount`, then
// fromTWD(amount, 'USD', fxRate) divides by fxRate a second time, producing
// TWD_total / fxRate² instead of TWD_total / fxRate.
//
// Symptom: portfolio with 2,610,600 TWD showed
//   - TWD display:  $261.06W  (correct)
//   - USD display:  $25.18K   (WRONG; should be $81.07K with fxRate=32.2)
// The bug only manifested in USD mode because fromTWD(amount, 'TWD', fxRate)
// is a no-op; the TWD display was correct.
//
// Fix: replace `this.displayCurrency` with `displayCurrency` (bare
// identifier) in the 5 affected x-text expressions — Alpine's reactive
// Proxy resolves the bare identifier correctly. Other `this.X` uses live
// inside method bodies where `this` IS the Alpine component; those are
// unaffected.
//
// Regression: assert that for a known portfolio, Net Worth / Holdings Value
// / Cash / Debts cards show consistent TWD and USD values (i.e.,
// USD_value * fxRate == TWD_value).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Fixture: 1 USD holding + 1 TWD holding + 1 USD cash account + 1 TWD debt.
// fx_rate = 32.2.
//
// Expected math:
//   Holdings: 100*250 USD + 100*26106 TWD = 25,000 USD + 2,610,600 TWD
//             in TWD: 25000*32.2 + 2610600 = 805,000 + 2,610,600 = 3,415,600 TWD = $341.56W
//             in USD: 25000 + 2610600/32.2 = 25,000 + 81,074.5 = 106,074.5 USD = $106.07K
//   Cash:     50,000 USD + 100,000 TWD
//             in TWD: 50000*32.2 + 100000 = 1,610,000 + 100,000 = 1,710,000 TWD = $171.00W
//             in USD: 50000 + 100000/32.2 = 50,000 + 3,105.6 = 53,105.6 USD = $53.11K
//   Debts:    1,000,000 TWD
//             in TWD: 1,000,000 TWD = $100.00W
//             in USD: 1,000,000 / 32.2 = 31,055.9 USD = $31.06K
//   NetWorth: 3,415,600 + 1,710,000 - 1,000,000 = 4,125,600 TWD = $412.56W
//             in USD: 106,074.5 + 53,105.6 - 31,055.9 = 128,124.2 USD = $128.12K
const PORTFOLIO_FIXTURE = {
  version: '1.1',
  holdings: [
    {
      id: 'h-usd',
      ticker: 'AAPL',
      shares: 100,
      cost: 100,
      currency: 'USD',
      current_price: 250,
      low_52w: 200,
      high_52w: 300,
      prev_close: 250,
      inactive: false,
      attributes: {},
    },
    {
      id: 'h-twd',
      ticker: '2330.TW',
      shares: 100,
      cost: 20000,
      currency: 'TWD',
      current_price: 26106,
      low_52w: 20000,
      high_52w: 28000,
      prev_close: 26106,
      inactive: false,
      attributes: {},
    },
  ],
  cash_accounts: [
    { id: 'c-usd', name: 'USD savings', balance: 50000, currency: 'USD', inactive: false, attributes: {} },
    { id: 'c-twd', name: 'TWD savings', balance: 100000, currency: 'TWD', inactive: false, attributes: {} },
  ],
  debts: [
    { id: 'd1', name: 'Mortgage', balance: 1000000, currency: 'TWD', interest_rate: null, inactive: false, attributes: {} },
  ],
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
    device_id: 'summary-currency-smoke-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

const INIT_SCRIPT = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(PORTFOLIO_FIXTURE)}));
window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
`;

function parseAmount(text) {
  // "$341.71W" → 341.71 (units of 10,000 TWD); "$106.07K" → 106.07 (thousands USD);
  // "$100.00W" → 100.00; "$31.06K" → 31.06. The unit prefix in format.js
  // depends on displayCurrency; in TWD it's W=10^4 and in USD it's K=10^3.
  const m = text.match(/\$([0-9,]+\.\d{2})([WMK]?)/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  const suffix = m[2];
  if (suffix === 'W') return value * 10_000;
  if (suffix === 'K') return value * 1_000;
  if (suffix === 'M') return value * 1_000_000;
  if (suffix === 'Y') return value * 100_000_000;
  return value; // no suffix = raw
}

test.describe('Home summary cards — TWD ↔ USD consistency (regression)', () => {
  test('summary card values are internally consistent across displayCurrency toggle', async ({ page }) => {
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

    await page.addInitScript(INIT_SCRIPT);
    await page.goto('/portfolio.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Capture TWD values
    const twdNetWorth = parseAmount(await page.locator('p:has-text("Total Net Worth") + p').first().textContent());
    const twdHoldings = parseAmount(await page.locator('p:has-text("Holdings Value") + p').first().textContent());
    const twdCash = parseAmount(await page.locator('p:has-text("Cash") + p').first().textContent());
    const twdDebts = parseAmount(await page.locator('p:has-text("Debts") + p').first().textContent());

    // Toggle to USD via the header currency button
    await page.locator('button:has-text("USD")').first().click();
    await page.waitForTimeout(500);

    const usdNetWorth = parseAmount(await page.locator('p:has-text("Total Net Worth") + p').first().textContent());
    const usdHoldings = parseAmount(await page.locator('p:has-text("Holdings Value") + p').first().textContent());
    const usdCash = parseAmount(await page.locator('p:has-text("Cash") + p').first().textContent());
    const usdDebts = parseAmount(await page.locator('p:has-text("Debts") + p').first().textContent());

    console.log(`TWD: NW=${twdNetWorth} H=${twdHoldings} C=${twdCash} D=${twdDebts}`);
    console.log(`USD: NW=${usdNetWorth} H=${usdHoldings} C=${usdCash} D=${usdDebts}`);

    // Regression assertions: USD values are NOT TWD values divided by fxRate twice.
    // The bug showed USD values ~fxRate times too small. With fxRate=32.2,
    // a buggy USD display would be ~3% of the correct USD display.
    //
    // Correct invariant: USD_value * fxRate ≈ TWD_value (within rounding
    // from the compact-suffix display).
    const FX = 32.2;
    const ratio = (usd) => Math.abs((usd * FX) - (twdNetWorth || twdHoldings || twdCash || twdDebts));
    expect(Math.abs((usdNetWorth * FX) - twdNetWorth)).toBeLessThan(twdNetWorth * 0.05);
    expect(Math.abs((usdHoldings * FX) - twdHoldings)).toBeLessThan(twdHoldings * 0.05);
    expect(Math.abs((usdCash * FX) - twdCash)).toBeLessThan(twdCash * 0.05);
    expect(Math.abs((usdDebts * FX) - twdDebts)).toBeLessThan(twdDebts * 0.05);

    // More specific: assert against the expected math (rounded to compact display).
    // Holdings: 3,415,600 TWD = $341.56W; 106,074.5 USD = $106.07K
    expect(twdHoldings).toBeCloseTo(3415600, -3);
    expect(usdHoldings).toBeCloseTo(106070, -2);
    // Cash: 1,710,000 TWD = $171.00W; 53,105.6 USD = $53.11K
    expect(twdCash).toBeCloseTo(1710000, -3);
    expect(usdCash).toBeCloseTo(53110, -1);
    // Debts: 1,000,000 TWD = $100.00W; 31,055.9 USD = $31.06K
    expect(twdDebts).toBeCloseTo(1000000, -3);
    expect(usdDebts).toBeCloseTo(31060, -1);
    // Net Worth: 4,125,600 TWD = $412.56W; 128,124.2 USD = $128.12K
    expect(twdNetWorth).toBeCloseTo(4125600, -3);
    expect(usdNetWorth).toBeCloseTo(128120, -2);

    expect(errors).toEqual([]);
  });

  test('Holdings page: USD holding total value still converts to displayCurrency', async ({ page }) => {
    // Sanity: with the same fixture, navigating to Holdings page should
    // still show the USD holding's position-level fields converted per
    // ADR 0021 (act vs measure). Per-holding gain/loss still in USD.
    // This guards against a too-aggressive fix that breaks the v1.14
    // act-vs-measure behavior.

    const errors = [];
    page.on('pageerror', (e) => {
      if (/u is not a function/i.test(e.message)) return;
      errors.push(`pageerror: ${e.message}`);
    });

    await page.addInitScript(INIT_SCRIPT);
    await page.goto('/portfolio.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Navigate to Holdings page
    await page.locator('button:has-text("Holdings"), a:has-text("Holdings")').first().click();
    await page.waitForTimeout(500);

    // Find AAPL row and check value/gain (TWD mode, fxRate=32.2):
    // 100 shares × $250 = $25,000 USD = 805,000 TWD = $80.50W
    const aaplValueCell = page.locator('tr:has-text("AAPL") td:has-text("W"), tr:has-text("AAPL") td:has-text("K")').first();
    const valueText = await aaplValueCell.textContent();
    // Value cell should show $80.50W (converted) — not $25.00K (unconverted)
    expect(valueText).toMatch(/\$80\.50W/);

    expect(errors).toEqual([]);
  });
});