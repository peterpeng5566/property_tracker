// tests/browser/categories-guard.spec.js — Playwright browser smoke for
// the Categories-page roadside guard (v1.4 ticket 05).
//
// Run: stage 4 of ./scripts/safety-net.sh (Playwright owns its own
// test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 05 / spec §Roadside guard):
//   - deleteCategory refuses when a plan's `when` or `distribute`
//     references the category, showing the i18n alert count
//   - deleteCategory succeeds (with confirm) when no plan references
//     the category
//   - deleteValue refuses when a plan's `when[cat]` or `distribute[cat]`
//     references the value, showing the i18n alert count
//
// Wiring notes:
//   - Fixture injection via localStorage (same pattern as plans.spec.js)
//   - window.alert is captured via page.on('dialog', ...) — Playwright
//     surfaces `alert()` as a `Dialog` with message()

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Fixture preloaded with:
//   - 1 holding with attributes { region: TW, type: stock }
//   - 2 categories (Region + Type) with their values
//   - 1 active plan referencing TW in `when` and stock/bond in `distribute`
//     so both category- and value-level roadside guards can fire
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
    // One plan already referencing both categories — guards on either
    // delete category/value must fire.
    plans: [{
      id: 'plan-pre',
      name: 'Pre-existing',
      rules: [{
        id: 'rule-pre',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 60, 'val-bond': 40 } },
      }],
      updated_at: '2024-07-01T00:00:00.000Z',
      device_id: 'roadside-guard-test',
    }],
    active_plan_id: 'plan-pre',
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
      device_id: 'roadside-guard-test-device',
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

// Same error-collection discipline as plans.spec.js — favicon 404,
// CDN noise, and Alpine 3.13.3 transition races are pre-existing
// noise (see tests/browser/backups.spec.js for the canonical list).
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

test.describe('portfolio.html roadside guard (ticket #05)', () => {
  test('deleteCategory: blocked when a plan references the category — alert, category survives', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Navigate to Categories tab
    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);

    // Categories are rendered in fixture order: cat-region first → its
    // "Delete category" × button is the first match in the page.
    const deleteCategoryButtons = await page.locator('button[title="Delete category"]').all();
    expect(deleteCategoryButtons.length).toBeGreaterThan(0);
    await deleteCategoryButtons[0].click();
    await page.waitForTimeout(300);

    // An alert must have fired with the i18n count message
    const alert = dialogs.find(d => d.kind === 'alert');
    expect(alert, 'an alert must fire before window.confirm').toBeTruthy();
    expect(alert.message).toMatch(/1 plan references this category/);

    // No confirm should have fired (the guard exits before confirm)
    expect(dialogs.some(d => d.kind === 'prompt' || d.kind === 'confirm')).toBe(false);

    // Reload from storage to verify the category was NOT deleted
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored.categories.some(c => c.id === 'cat-region')).toBe(true);

    expect(errors).toEqual([]);
  });

  test('deleteCategory: succeeds (with confirm) when no plan references the category', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept(); // accept both the alert (none expected) and confirm
    });

    // Fixture WITHOUT plans so no guard fires
    const fixture = makeFixture();
    fixture.plans = [];
    fixture.active_plan_id = null;

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);

    await page.locator('button[title="Delete category"]').first().click();
    await page.waitForTimeout(300);

    // No alert — confirm dialog must be the only one
    expect(dialogs.some(d => d.kind === 'alert')).toBe(false);
    expect(dialogs.some(d => d.kind === 'confirm')).toBe(true);

    // Reload to verify the category WAS removed
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored.categories.some(c => c.id === 'cat-region')).toBe(false);

    expect(errors).toEqual([]);
  });

  test('deleteValue: blocked when a plan references the value — alert, value survives', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);

    // Values are rendered in fixture order per category card, and cards
    // themselves are in fixture order. Layout is flat — all "Delete
    // value" × buttons live in <li> elements, but they render as a
    // single block (one per value), so the 3rd button is val-stock:
    //   0: cat-region → val-TW
    //   1: cat-region → val-US
    //   2: cat-type   → val-stock   ← this plan references { cat-type: { val-stock: 60 } }
    //   3: cat-type   → val-bond
    const valueButtons = await page.locator('button[title="Delete value"]').all();
    expect(valueButtons.length).toBe(4);
    await valueButtons[2].click();
    await page.waitForTimeout(300);

    const alert = dialogs.find(d => d.kind === 'alert');
    expect(alert, 'an alert must fire before window.confirm').toBeTruthy();
    expect(alert.message).toMatch(/1 plan references this value/);
    expect(dialogs.some(d => d.kind === 'confirm')).toBe(false);

    // Stock value still present
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    const typeCat = stored.categories.find(c => c.id === 'cat-type');
    expect(typeCat.values.some(v => v.id === 'val-stock')).toBe(true);

    expect(errors).toEqual([]);
  });

  test('roadside guard is plan-emptive, not category-emptive: deleting the plan unlocks the category', async ({ page }) => {
    const errors = collectAppErrors(page);
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push({ kind: d.type(), message: d.message() });
      if (d.type() === 'confirm') await d.accept();
      else await d.accept();
    });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // First: delete attempt is blocked
    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);
    await page.locator('button[title="Delete category"]').first().click();
    await page.waitForTimeout(300);
    expect(dialogs.some(d => d.kind === 'alert')).toBe(true);

    // Now delete the plan that references the category
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-delete"]').first().click();
    await page.waitForTimeout(300);

    // Re-attempt: now succeeds with confirm
    dialogs.length = 0;
    await page.locator('button:has-text("Categories")').first().click();
    await page.waitForTimeout(200);
    await page.locator('button[title="Delete category"]').first().click();
    await page.waitForTimeout(300);
    expect(dialogs.some(d => d.kind === 'alert')).toBe(false);
    expect(dialogs.some(d => d.kind === 'confirm')).toBe(true);

    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
    expect(stored.categories.some(c => c.id === 'cat-region')).toBe(false);

    expect(errors).toEqual([]);
  });
});
