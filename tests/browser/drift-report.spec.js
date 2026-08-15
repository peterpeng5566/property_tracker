// tests/browser/drift-report.spec.js — Playwright browser smoke for
// the Home-page drift report (v1.4 ticket 04).
//
// Run: stage 4 of ./scripts/safety-net.sh (Playwright owns its own
// test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 04 / spec §Acceptance criteria):
//   - With 1 active plan × 3 rules + matching holdings, all 3 cards
//     render with correct rule names (variant B layout)
//   - Active plan switcher at top of section re-renders the cards
//   - "Unset active" button hides the section
//   - Rule matching 1 record shows the inline amber warning
//   - Rule matching 0 records shows the italic 0-match footer
//   - Record missing the distribute target attribute shows the
//     `_unassigned` row at the bottom of its card
//
// Wiring: portfolio fixture is injected via page.addInitScript into
// localStorage under STORAGE_KEY. window.confirm auto-accepted via
// page.on('dialog', ...).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Fixture for the basic 3-rule drift scenario.
//
// Plan "Aggressive Growth" with 3 rules:
//   - "TW sleeve"    when country=TW         distribute stock/bond 70/30
//   - "US sleeve"    when country=US         distribute stock/bond 60/40 (1-record match)
//   - "All stock"    when type=stock         distribute country TW/US 50/50
//
// 4 holdings: TW-stock $600, TW-bond $200, US-stock $450 (no US-bond
// — that's the 1-record match case), US-bond (no region — that's the
// _unassigned case for the "All stock" rule because the distribute
// target is region, and a "stock" record with no region attribute
// falls into _unassigned).
//
// Note on `cost_basis_recordsAttributes`: we use attributes map (per
// record ID) so the lib can filter / group without coupling to the
// holdings/cash/debts shape — exactly how the Alpine shim builds it.
function makeFixture() {
  return {
    version: '1.1',
    holdings: [
      {
        id: 'h-twstock', ticker: '2330.TW', shares: 1000, cost: 50,
        currency: 'TWD', current_price: 600,
        attributes: { 'cat-country': 'val-TW', 'cat-type': 'val-stock' },
      },
      {
        id: 'h-twbond', ticker: 'TWBOND', shares: 2000, cost: 100,
        currency: 'TWD', current_price: 100,
        attributes: { 'cat-country': 'val-TW', 'cat-type': 'val-bond' },
      },
      {
        id: 'h-usstock', ticker: 'AAPL', shares: 10, cost: 150,
        currency: 'USD', current_price: 200,
        attributes: { 'cat-country': 'val-US', 'cat-type': 'val-stock' },
      },
      {
        // Stock with no country attribute — when "All stock" rule's
        // distribute target is country, this record has no country, so
        // it contributes to `_unassigned`.
        id: 'h-nocountry', ticker: 'ORPHAN', shares: 100, cost: 50,
        currency: 'TWD', current_price: 50,
        attributes: { 'cat-type': 'val-stock' },
      },
    ],
    cash_accounts: [],
    debts: [],
    categories: [
      {
        id: 'cat-country', name: 'Country',
        applies_to: ['holdings', 'cash', 'debt'],
        values: [
          { id: 'val-TW', name: 'TW' },
          { id: 'val-US', name: 'US' },
        ],
      },
      {
        id: 'cat-type', name: 'Type',
        applies_to: ['holdings', 'cash', 'debt'],
        values: [
          { id: 'val-stock', name: 'Stock' },
          { id: 'val-bond', name: 'Bond' },
        ],
      },
    ],
    snapshots: [],
    plans: [{
      id: 'plan-grow',
      name: 'Aggressive Growth',
      rules: [
        {
          id: 'rule-tw', name: 'TW sleeve',
          when: { 'cat-country': ['val-TW'] },
          distribute: { 'cat-type': { 'val-stock': 70, 'val-bond': 30 } },
        },
        {
          id: 'rule-us', name: 'US sleeve',
          when: { 'cat-country': ['val-US'] },
          distribute: { 'cat-type': { 'val-stock': 60, 'val-bond': 40 } },
        },
        {
          id: 'rule-stock', name: 'All stock',
          when: { 'cat-type': ['val-stock'] },
          distribute: { 'cat-country': { 'val-TW': 50, 'val-US': 50 } },
        },
      ],
    }],
    active_plan_id: 'plan-grow',
    backups: [],
    deletions: [],
    settings: {
      display_currency: 'TWD',
      language: 'en',
      cost_format: 'per_share',
      fx_source: 'manual',
      fx_rate: 32,
    },
    meta: {
      device_id: 'drift-smoke-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

// Fixture variant with NO active plan (for the empty-state test).
function makeFixtureNoActive() {
  const f = makeFixture();
  f.active_plan_id = null;
  return f;
}

// Fixture variant with a plan that references a category without
// values (forces the 0-match footer scenario).
function makeFixtureNoMatch() {
  const f = makeFixture();
  f.plans[0].rules.push({
    id: 'rule-empty', name: 'No match rule',
    // Choose a category value that no record has.
    when: { 'cat-country': ['val-NONEXISTENT'] },
    distribute: { 'cat-type': { 'val-stock': 60, 'val-bond': 40 } },
  });
  return f;
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

test.describe('portfolio.html drift report (ticket #04)', () => {
  test('cards render in saved rule order with correct names', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Home page is default. Section visible because active_plan_id set.
    await expect(page.locator('[data-testid=drift-section]')).toBeVisible();

    // 3 cards visible, in saved rule order
    const cards = page.locator('[data-testid=drift-card]');
    await expect(cards).toHaveCount(3);

    const names = await cards.locator('[data-testid=drift-card-name]').allTextContents();
    expect(names).toEqual(['TW sleeve', 'US sleeve', 'All stock']);

    expect(errors).toEqual([]);
  });

  test('US sleeve shows 1-record warning inline', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Second card (index 1) is US sleeve. Only the 1-record warning
    // should be visible (TW sleeve has 2 records; All stock has 3).
    const cards = page.locator('[data-testid=drift-card]');
    await expect(cards.nth(1).locator('[data-testid=drift-card-one-record-warning]')).toBeVisible();
    await expect(cards.nth(0).locator('[data-testid=drift-card-one-record-warning]')).not.toBeVisible();
    await expect(cards.nth(2).locator('[data-testid=drift-card-one-record-warning]')).not.toBeVisible();

    expect(errors).toEqual([]);
  });

  test('All stock card shows _unassigned row for records with no country attribute', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Card 3 (All stock) — distribute is country TW/US. The "h-nocountry"
    // holding has type=stock but no country. So _unassigned row should
    // be present on this card only.
    const cardAllStock = page.locator('[data-testid=drift-card]').nth(2);
    await expect(cardAllStock.locator('[data-testid=drift-row-_unassigned]')).toBeVisible();
    // TW sleeve / US sleeve are distribute: type, not country, and all
    // TW/US holdings have a type attribute in the fixture — so no
    // _unassigned row there.
    await expect(page.locator('[data-testid=drift-card]').nth(0).locator('[data-testid=drift-row-_unassigned]')).toHaveCount(0);
    await expect(page.locator('[data-testid=drift-card]').nth(1).locator('[data-testid=drift-row-_unassigned]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('rule matching 0 records shows italic footer', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureNoMatch()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 4 cards total now; the "No match rule" rule is at index 3.
    const cards = page.locator('[data-testid=drift-card]');
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(3).locator('[data-testid=drift-card-no-matching]')).toBeVisible();
    await expect(cards.nth(0).locator('[data-testid=drift-card-no-matching]')).not.toBeVisible();

    expect(errors).toEqual([]);
  });

  test('no active plan → drift section hidden', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureNoActive()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    await expect(page.locator('[data-testid=drift-section]')).not.toBeVisible();

    expect(errors).toEqual([]);
  });

  test('Unset active hides the drift section', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixture()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Start: section visible.
    await expect(page.locator('[data-testid=drift-section]')).toBeVisible();

    // Click Unset → section hides.
    await page.locator('[data-testid=drift-unset-active]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid=drift-section]')).not.toBeVisible();

    expect(errors).toEqual([]);
  });

  test('active plan switcher re-renders cards for new plan', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    // Make a fixture with two plans so we can switch.
    const f = makeFixture();
    f.plans.push({
      id: 'plan-swap', name: 'Conservative', rules: [{
        id: 'rule-swap', name: 'Catch-all bonds',
        when: { 'cat-type': ['val-bond'] },
        distribute: { 'cat-country': { 'val-TW': 100 } },
      }],
    });
    await page.addInitScript(initScript(f));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Start with Aggressive Growth active.
    let cards = page.locator('[data-testid=drift-card]');
    await expect(cards).toHaveCount(3);

    // Switch to Conservative.
    await page.locator('[data-testid=drift-active-plan-select]').selectOption({ label: 'Conservative' });
    await page.waitForTimeout(200);
    await expect(cards).toHaveCount(1);
    await expect(cards.locator('[data-testid=drift-card-name]').first()).toHaveText('Catch-all bonds');

    // Switch back.
    await page.locator('[data-testid=drift-active-plan-select]').selectOption({ label: 'Aggressive Growth' });
    await page.waitForTimeout(200);
    await expect(cards).toHaveCount(3);

    expect(errors).toEqual([]);
  });
});
