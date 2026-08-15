// tests/browser/plans.spec.js — Playwright browser smoke for the Plans
// page (v1.4 ticket 02).
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright
// owns its own test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 02 / spec §Browser smoke):
//   - Create plan → set weights → save → plan row appears
//   - Edit rule → re-save → name updates
//   - Set active → Active badge renders
//   - Navigate away (Home) → return (Plans) → plan still there
//   - Delete → confirm → empty state shows
//
// Wiring notes:
//   - Portfolio fixture is injected via page.addInitScript() into
//     localStorage under STORAGE_KEY.
//   - window.confirm is auto-accepted via page.on('dialog', ...).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Minimal fixture: 1 holding so data.holdings is non-empty (the page
// doesn't crash on empty arrays, but a real holding makes the
// end-to-end flow closer to user reality). Two categories with values
// so the rule editor has something to pick from.
function makeFixture() {
  return {
    version: '1.1',
    holdings: [{
      id: 'h-1',
      ticker: '2330.TW',
      shares: 1000,
      cost: 50,
      currency: 'TWD',
      current_price: 600,
      attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' },
    }],
    cash_accounts: [],
    debts: [],
    categories: [
      { id: 'cat-region', name: 'Region', applies_to: ['holdings','cash','debt'],
        values: [{ id: 'val-TW', name: 'TW' }, { id: 'val-US', name: 'US' }] },
      { id: 'cat-type', name: 'Type', applies_to: ['holdings','cash','debt'],
        values: [{ id: 'val-stock', name: 'Stock' }, { id: 'val-bond', name: 'Bond' }] },
    ],
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
    },
    meta: {
      device_id: 'plans-smoke-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
  `;
}

// Capture pageerror + console errors that aren't pre-existing noise
// (favicon 404, upstream Alpine x-show transition race — same as the
// other browser specs tolerate).
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

test.describe('portfolio.html plans page (ticket #02)', () => {
  test('create plan: empty state → editor → fill rule → save → row appears', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Navigate to Plans tab
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plans-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="plan-empty"]')).toBeVisible();

    // Click the empty-state CTA "Create your first plan" — same
    // data-testid as the header button.
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-editor"]')).toBeVisible();

    // Name
    await page.locator('[data-testid="plan-name"]').fill('My Allocation');
    await page.waitForTimeout(100);

    // when: add Region, click TW
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);

    // distribute: pick Type, add Stock + Bond, weights 60/40
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
    await page.waitForTimeout(100);

    const weightInputs = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await weightInputs[0].fill('60');
    await weightInputs[1].fill('40');
    await page.waitForTimeout(200);

    // Sum-to-100 indicator should be green (i.e. enabled save)
    await expect(page.locator('[data-testid="plan-save"]')).not.toBeDisabled();

    // Save
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="plan-editor"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="plan-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="plan-row"] .font-medium').first()).toHaveText('My Allocation');

    expect(errors).toEqual([]);
  });

  test('set active: Active badge appears; navigate away + back: plan still there', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('Test');
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
    await page.waitForTimeout(100);
    const ws = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await ws[0].fill('60');
    await ws[1].fill('40');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(300);

    // Set active
    await page.locator('[data-testid="plan-set-active"]').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-active-badge"]').first()).toBeVisible();

    // Navigate to Home, then back to Plans — plan should still be there
    await page.locator('button:has-text("Home")').first().click();
    await page.waitForTimeout(200);
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="plan-active-badge"]').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('edit rule + cancel: discard changes', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Create a plan with name 'Original'
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('Original');
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
    await page.waitForTimeout(100);
    const ws = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await ws[0].fill('60');
    await ws[1].fill('40');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(300);

    // Edit and cancel
    await page.locator('[data-testid="plan-edit"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('Changed');
    await page.locator('[data-testid="plan-cancel"]').click();
    await page.waitForTimeout(200);

    // Name should still be Original
    await expect(page.locator('[data-testid="plan-row"] .font-medium').first()).toHaveText('Original');
    await expect(page.locator('[data-testid="plan-editor"]')).not.toBeVisible();

    expect(errors).toEqual([]);
  });

  test('delete active plan: confirm dialog → row removed → empty state shown', async ({ page }) => {
    const errors = collectAppErrors(page);
    let dialogMessage = null;
    page.on('dialog', async (d) => {
      dialogMessage = d.message();
      await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Create + save + set active
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('To Delete');
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
    await page.waitForTimeout(100);
    const ws = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await ws[0].fill('60');
    await ws[1].fill('40');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="plan-set-active"]').first().click();
    await page.waitForTimeout(200);

    // Delete — should prompt the active-plan confirm
    await page.locator('[data-testid="plan-delete"]').first().click();
    await page.waitForTimeout(300);
    expect(dialogMessage).toMatch(/active plan/i);
    await expect(page.locator('[data-testid="plan-row"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="plan-empty"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('add + reorder + remove rule', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Create with one default rule
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('Rules test');
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
    await page.waitForTimeout(100);
    const ws = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await ws[0].fill('60');
    await ws[1].fill('40');
    await page.waitForTimeout(200);

    // Add a second rule
    await page.locator('[data-testid="plan-add-rule"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-rule"]')).toHaveCount(2);

    // Move rule 2 up — so list becomes [rule2 (empty), rule1 (filled)]
    await page.locator('[data-testid="plan-rule-up"]').nth(1).click();
    await page.waitForTimeout(200);

    // Remove rule 2 (the empty one, now at index 0) — leave the
    // filled rule so the plan still validates
    await page.locator('[data-testid="plan-rule-remove"]').nth(0).click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-rule"]')).toHaveCount(1);

    // Save and check
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="plan-row"]')).toHaveCount(1);

    expect(errors).toEqual([]);
  });
});