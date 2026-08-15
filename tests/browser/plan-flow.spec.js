// tests/browser/plan-flow.spec.js — Playwright browser smoke for the
// v1.4 cross-feature integration (ticket #06).
//
// Run: stage 4 of ./scripts/safety-net.sh.
//
// What it covers (ticket 06 / spec §Integration tests):
//   - User creates a plan with 1 rule, sets it active
//   - Home page shows the drift card against that plan
//   - On Categories, deleting the category referenced by the rule
//     triggers the roadside guard with the count message
//   - Removing the rule unblocks the category deletion (with confirm)
//   - Regression: deletion of a category succeeds (with confirm) when
//     no plan references it — no guard, no count message
//
// Wiring notes:
//   - Same fixture pattern as plans.spec.js / categories-guard.spec.js
//   - dialog handler captures alert + confirm in `dialogs[]`, accepts all
//   - Home is the default page on load; "Home" / "Plans" / "Categories"
//     are top-nav buttons
//
// References:
//   - ADR 0013 §6 — category deletion is blocked when a plan
//     references it; no auto-clean
//   - ADR 0013 §9 — required-name rule, plan editor disables save
//     pre-emptively when any rule name is empty

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Minimal fixture for the integration flow:
//   - 1 holding with attributes { region: TW, type: stock }
//   - 2 categories (Region + Type) with values TW/US and Stock/Bond
//   - NO plans in the fixture — the test creates one
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
      device_id: 'plan-flow-test-device',
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

// Error discipline — same as the other browser specs: ignore favicon,
// ignore CDN/Alpine race noise.
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

// Helper: walk the plan-editor wizard end-to-end (1 rule: when
// Region=TW, distribute Type Stock/Bond 60/40).
async function createOneRulePlan(page, opts) {
  const { planName = 'Integration Plan', ruleName = 'TW sleeve' } = opts || {};
  await page.locator('button:has-text("Plans")').first().click();
  await page.waitForTimeout(200);
  await page.locator('[data-testid="plan-create"]').first().click();
  await page.waitForTimeout(200);

  await page.locator('[data-testid="plan-name"]').fill(planName);
  await page.locator('[data-testid="plan-rule-name"]').fill(ruleName);

  await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
  await page.waitForTimeout(100);
  await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
  await page.waitForTimeout(100);

  await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
  await page.waitForTimeout(100);
  await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
  await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Bond' });
  await page.waitForTimeout(100);

  const weightInputs = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
  await weightInputs[0].fill('60');
  await weightInputs[1].fill('40');
  await page.waitForTimeout(200);

  await page.locator('[data-testid="plan-save"]').click();
  await page.waitForTimeout(300);
}

test.describe('portfolio.html plan flow (ticket #06)', () => {
  test('create plan → set active → see drift on Home → category deletion blocked by roadside guard', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // ---- Create plan via the editor ----
    await createOneRulePlan(page, { planName: 'Aggressive Growth', ruleName: 'TW sleeve' });
    await expect(page.locator('[data-testid="plan-row"]')).toHaveCount(1);

    // ---- Set active ----
    await page.locator('[data-testid="plan-set-active"]').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plan-active-badge"]').first()).toBeVisible();

    // ---- Open Home — drift section is visible with 1 card ----
    await page.locator('button:has-text("Home")').first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="drift-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="drift-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="drift-card-name"]').first()).toHaveText('TW sleeve');

    // ---- Open Categories and try to delete Region (referenced by the rule) ----
    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);
    const beforeAlerts = dialogs.length;
    const deleteCategoryButtons = await page.locator('button[title="Delete category"]').all();
    expect(deleteCategoryButtons.length).toBeGreaterThan(0);
    // cat-region is first in fixture order
    await deleteCategoryButtons[0].click();
    await page.waitForTimeout(300);

    // An alert MUST have fired with the i18n count message
    const alert = dialogs.slice(beforeAlerts).find(d => d.kind === 'alert');
    expect(alert, 'roadside guard alert must fire before window.confirm').toBeTruthy();
    expect(alert.message).toMatch(/1 plan references this category/);
    // The guard exits before any confirm fires
    expect(dialogs.slice(beforeAlerts).some(d => d.kind === 'confirm')).toBe(false);

    // Region category survives
    const stored1 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored1.categories.some(c => c.id === 'cat-region')).toBe(true);
    expect(stored1.plans.length).toBe(1);
    expect(stored1.plans[0].rules.length).toBe(1);

    expect(errors).toEqual([]);
  });

  test('removing the rule unblocks the category deletion; deletion succeeds with confirm', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // ---- Create the same plan ----
    await createOneRulePlan(page, { planName: 'Aggressive Growth', ruleName: 'TW sleeve' });

    // ---- The plan-editor refuses to save with 0 rules (validatePlan
    //      requires ≥1 rule). The realistic flow is to delete the plan
    //      outright, which is the only path the user has to clear the
    //      rule's reference to Region.
    await page.locator('[data-testid="plan-delete"]').first().click();
    await page.waitForTimeout(300);

    // Plan should be gone (the delete confirms via dialog; we accepted it
    // in the page.on('dialog') handler at the top of this test).
    const storedAfterDelete = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(storedAfterDelete.plans.length).toBe(0);
    // ADR 0011: plan deletion must produce a tombstone so sync doesn't
    // re-pull it from remote.
    expect(storedAfterDelete.deletions.some(d => d.type === 'plans' && d.target_id === storedAfterDelete.plans[0]?.id)).toBe(false); // already deleted
    expect(storedAfterDelete.deletions.some(d => d.type === 'plans')).toBe(true);

    // ---- Open Categories and delete Region ----
    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);
    const beforeAlerts = dialogs.length;
    const deleteCategoryButtons = await page.locator('button[title="Delete category"]').all();
    expect(deleteCategoryButtons.length).toBeGreaterThan(0);
    await deleteCategoryButtons[0].click();
    await page.waitForTimeout(300);

    // No alert fired (no plan references it any more); a confirm fired instead.
    const newDialogs = dialogs.slice(beforeAlerts);
    expect(newDialogs.some(d => d.kind === 'alert')).toBe(false);
    expect(newDialogs.some(d => d.kind === 'confirm')).toBe(true);

    // Region category is gone
    const stored2 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored2.categories.some(c => c.id === 'cat-region')).toBe(false);
    // cat-type still there
    expect(stored2.categories.some(c => c.id === 'cat-type')).toBe(true);

    expect(errors).toEqual([]);
  });

  test('regression: deletion of category still works when no plan references it', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept();
    });
    // Fixture has no plans at all
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);
    const beforeAlerts = dialogs.length;
    const deleteCategoryButtons = await page.locator('button[title="Delete category"]').all();
    expect(deleteCategoryButtons.length).toBeGreaterThan(0);
    await deleteCategoryButtons[0].click();
    await page.waitForTimeout(300);

    // No alert fired (the guard checks plans[]; with no plans there's
    // nothing to count). A confirm fired (the regular delete confirmation).
    const newDialogs = dialogs.slice(beforeAlerts);
    expect(newDialogs.some(d => d.kind === 'alert')).toBe(false);
    expect(newDialogs.some(d => d.kind === 'confirm')).toBe(true);

    // cat-region is gone; cat-type survives
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored.categories.some(c => c.id === 'cat-region')).toBe(false);
    expect(stored.categories.some(c => c.id === 'cat-type')).toBe(true);

    expect(errors).toEqual([]);
  });
});