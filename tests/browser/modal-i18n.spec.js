// tests/browser/modal-i18n.spec.js — v1.10 i18n modal placeholders.
//
// Run: stage 4 of `./scripts/safety-net.sh`.
//
// What it covers:
//   - The Add Cash modal's `cashForm.name` input has a placeholder that
//     runs through the i18n system. Placeholder text must match the
//     active locale (EN or zh). Hardcoded placeholders (the v1.0-v1.9
//     bug) are visible to users in the wrong locale and render as
//     squares in CJK-glyph-less environments.
//   - Same for the Add Debt modal's `debtForm.name` input.
//
// Stays in EN+zh (the two supported locales per the i18n bundle at
// portfolio.html:2765). Other locales fall back to EN at the bundle
// level so they don't need explicit assertions here.
//
// TDD note: this file is the **red** fixture at v1.10 commit 1.
// All three tests fail because the production markup still has
// `placeholder="e.g., 台新銀行活存"` / `placeholder="e.g., 房貸、學貸、信貸"`
// hardcoded. The fix swap ends with `:placeholder="t('cash.namePlaceholder')"`
// etc. + new i18n keys in both bundles.

'use strict';

const { test, expect } = require('@playwright/test');

// Must match the constant in portfolio.html:2903.
const STORAGE_KEY = 'property_tracker_portfolio_v1';

const EN_NAME_PLACEHOLDER = 'e.g., Taishin Bank savings';
const EN_DEBT_PLACEHOLDER = 'e.g., Mortgage, student loan, personal loan';
const ZH_NAME_PLACEHOLDER = 'e.g., 台新銀行活存';
const ZH_DEBT_PLACEHOLDER = 'e.g., 房貸、學貸、信貸';
const EN_TICKER_PLACEHOLDER = 'e.g., 2330.TW or AAPL';
const ZH_TICKER_PLACEHOLDER = 'e.g., 2330.TW 或 AAPL';
const PER_SHARE_PLACEHOLDER = 'per share';

function emptyFixture(language) {
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
      language,
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32.2,
      snapshot_cap: 365,
    },
    meta: {
      device_id: 'modal-i18n-device',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
  `;
}

async function waitForAlpine(page) {
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine, { timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function openCashModal(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).showCashModal = true;
  });
  await page.waitForTimeout(150);
}

async function openDebtModal(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).showDebtModal = true;
  });
  await page.waitForTimeout(150);
}

async function openHoldingModal(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).showModal = true;
  });
  await page.waitForTimeout(150);
}

// ──────────────────────────────────────────────────────────────────────
// E2E
// ──────────────────────────────────────────────────────────────────────

test.describe('v1.10 — i18n modal placeholders (Cash + Debt)', () => {
  test('in EN locale, the Add Cash modal name placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('en')));
    await waitForAlpine(page);
    await openCashModal(page);

    const placeholder = await page.locator('input[x-model="cashForm.name"]').getAttribute('placeholder');
    expect(placeholder, 'EN cash.name placeholder must come from i18n').toBe(EN_NAME_PLACEHOLDER);
  });

  test('in EN locale, the Add Debt modal name placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('en')));
    await waitForAlpine(page);
    await openDebtModal(page);

    const placeholder = await page.locator('input[x-model="debtForm.name"]').getAttribute('placeholder');
    expect(placeholder, 'EN debts.name placeholder must come from i18n').toBe(EN_DEBT_PLACEHOLDER);
  });

  test('in zh locale, the Add Cash modal name placeholder is localised (regression for hardcoded EN→zh mismatch)', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('zh')));
    await waitForAlpine(page);
    await openCashModal(page);

    const placeholder = await page.locator('input[x-model="cashForm.name"]').getAttribute('placeholder');
    expect(placeholder, 'zh cash.name placeholder must come from i18n').toBe(ZH_NAME_PLACEHOLDER);
  });

  test('in zh locale, the Add Debt modal name placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('zh')));
    await waitForAlpine(page);
    await openDebtModal(page);

    const placeholder = await page.locator('input[x-model="debtForm.name"]').getAttribute('placeholder');
    expect(placeholder, 'zh debts.name placeholder must come from i18n').toBe(ZH_DEBT_PLACEHOLDER);
  });

  // ──────────────────────────────────────────────────────────────────────
  // v1.10 ticket 02 — sibling of the Cash + Debt commit. The Add Holding
  // modal's ticker / cost / current-price inputs were still hardcoded
  // `placeholder="..."` in English.
  // ──────────────────────────────────────────────────────────────────────

  test('in EN locale, the Add Holding modal ticker placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('en')));
    await waitForAlpine(page);
    await openHoldingModal(page);

    const placeholder = await page.locator('input[x-model="form.ticker"]').getAttribute('placeholder');
    expect(placeholder, 'EN modal.ticker placeholder must come from i18n').toBe(EN_TICKER_PLACEHOLDER);
  });

  test('in zh locale, the Add Holding modal ticker placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('zh')));
    await waitForAlpine(page);
    await openHoldingModal(page);

    const placeholder = await page.locator('input[x-model="form.ticker"]').getAttribute('placeholder');
    expect(placeholder, 'zh modal.ticker placeholder must come from i18n').toBe(ZH_TICKER_PLACEHOLDER);
  });

  test('in EN locale, the Add Holding modal cost placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('en')));
    await waitForAlpine(page);
    await openHoldingModal(page);

    // NB: `x-model.number="form.cost"` — CSS attribute selectors can't
    // contain `.` in the attribute name. Use `page.evaluate` +
    // `getAttribute` (which accepts any attribute name) to read the
    // placeholder directly.
    const placeholder = await page.evaluate(() => {
      const inputs = document.querySelectorAll('[x-show="showModal"] input');
      const found = [...inputs].find(i => i.getAttribute('x-model.number') === 'form.cost');
      return found ? found.getAttribute('placeholder') : null;
    });
    expect(placeholder, 'EN modal.costPerShare placeholder must come from i18n').toBe(PER_SHARE_PLACEHOLDER);
  });

  test('in zh locale, the Add Holding modal current-price placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('zh')));
    await waitForAlpine(page);
    await openHoldingModal(page);

    const placeholder = await page.evaluate(() => {
      const inputs = document.querySelectorAll('[x-show="showModal"] input');
      const found = [...inputs].find(i => i.getAttribute('x-model.number') === 'form.current_price');
      return found ? found.getAttribute('placeholder') : null;
    });
    expect(placeholder, 'zh modal.currentPrice placeholder must come from i18n').toBe(PER_SHARE_PLACEHOLDER);
  });
});
