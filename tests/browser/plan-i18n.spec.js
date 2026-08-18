// tests/browser/plan-i18n.spec.js — v1.10 i18n plan-editor placeholders.
//
// Run: stage 4 of `./scripts/safety-net.sh`.
//
// Sibling of `tests/browser/modal-i18n.spec.js` (covers Cash / Debt / Add
// Holding modal placeholders). This file covers the Plan editor rule
// name input on the Plans page, which is a different UI region (page
// body, not a modal) so it lives in its own spec.
//
// What it covers:
//   - The Plan editor's rule name input has a placeholder that runs
//     through the i18n system. Placeholder text must match the active
//     locale (EN or zh). The v1.0-v1.9 bug was hardcoded English
//     `"e.g. Domestic equities"` showing in zh locale too.
//
// TDD note: this file is the **red** fixture at v1.10 ticket 02.
// All tests fail because the production markup still has the hardcoded
// `placeholder="e.g. Domestic equities"`. The fix swap ends with
// `:placeholder="t('plan.editor.ruleNamePlaceholder')"` + new i18n keys
// in both bundles.

'use strict';

const { test, expect } = require('@playwright/test');

// Must match the constant in portfolio.html:2903.
const STORAGE_KEY = 'property_tracker_portfolio_v1';

const EN_RULE_NAME_PLACEHOLDER = 'e.g., Domestic equities';
const ZH_RULE_NAME_PLACEHOLDER = 'e.g., 國內股票';

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
      device_id: 'plan-i18n-device',
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

async function navigateTo(page, currentPage) {
  await page.evaluate((cp) => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).currentPage = cp;
  }, currentPage);
  await page.waitForTimeout(150);
}

// Open the Plan editor by calling `addPlan()` (creates a new plan draft
// with one empty rule so the rule name input is rendered).
async function openPlanEditor(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.addPlan();
  });
  await page.waitForTimeout(150);
}

// ──────────────────────────────────────────────────────────────────────
// E2E
// ──────────────────────────────────────────────────────────────────────

test.describe('v1.10 — i18n plan-editor placeholders', () => {
  test('in EN locale, the Plan editor rule name placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('en')));
    await waitForAlpine(page);
    await navigateTo(page, 'plans');
    await openPlanEditor(page);

    const placeholder = await page.locator('[data-testid="plan-rule-name"]').getAttribute('placeholder');
    expect(placeholder, 'EN plan.editor.ruleNamePlaceholder must come from i18n').toBe(EN_RULE_NAME_PLACEHOLDER);
  });

  test('in zh locale, the Plan editor rule name placeholder is localised', async ({ page }) => {
    await page.addInitScript(initScript(emptyFixture('zh')));
    await waitForAlpine(page);
    await navigateTo(page, 'plans');
    await openPlanEditor(page);

    const placeholder = await page.locator('[data-testid="plan-rule-name"]').getAttribute('placeholder');
    expect(placeholder, 'zh plan.editor.ruleNamePlaceholder must come from i18n').toBe(ZH_RULE_NAME_PLACEHOLDER);
  });
});
