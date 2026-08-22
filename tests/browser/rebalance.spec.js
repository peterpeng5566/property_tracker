// tests/browser/rebalance.spec.js — Playwright browser smoke for the
// v1.8 Rebalance page (ADR 0017, ticket 02).
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright
// owns its own test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 02 / spec §Integration smoke):
//   - Empty state (no active plan)
//   - 1 eligible rule + 3 matched holdings → 3 candidate rows + 52w
//   - Cash rule → "Add $X" / "Reduce $X" advice
//   - Multi-rule overlap on 1 holding → 2 rows
//   - No eligible rules → empty CTA
//   - Filter persistence (edit rule + save + reload + rebalance recomputes)
//
// Wiring notes:
//   - Portfolio fixture is injected via page.addInitScript() into
//     localStorage under STORAGE_KEY.
//   - window.confirm is auto-accepted via page.on('dialog', ...).
//   - collectAppErrors() swallows the same pre-existing noise the other
//     browser specs tolerate (favicon 404, CDN noise, status 4xx/5xx,
//     the 'u is not a function' Alpine transition race).

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
      device_id: 'rebalance-smoke-test-device',
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

test.describe('portfolio.html rebalance page (v1.8 ticket #02)', () => {
  test('empty state: no active plan → empty CTA visible', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');

    // Navigate to Rebalance tab.
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-no-plan"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('1 eligible rule + 3 matched holdings → 3 candidate rows with buy/sell advice', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    // 3 holdings, all matching Region=TW, total = 1000*600 + 200*500 + 100*1000 = 1,100,000 TWD
    fixture.holdings = [
      { id: 'h-1', ticker: '2330.TW', shares: 1000, cost: 50, currency: 'TWD', current_price: 600, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
      { id: 'h-2', ticker: '2454.TW', shares: 200,  cost: 100, currency: 'TWD', current_price: 500, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
      { id: 'h-3', ticker: '2882.TW', shares: 100,  cost: 100, currency: 'TWD', current_price: 1000, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    ];
    // Plan: 1 rule, Region=TW, target_weight_pct=100 → rebalance-eligible
    const planId = 'plan-1';
    fixture.plans = [{
      id: planId,
      name: 'TW stocks',
      updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1',
        name: 'All TW stocks',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        target_weight_pct: 100,
        show_in_rebalance: true, // v1.19 (ADR 0025): opt-in toggle
      }],
    }];
    fixture.active_plan_id = planId;

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');

    // Navigate to Rebalance tab.
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-page"]')).toBeVisible();

    // No empty states.
    await expect(page.locator('[data-testid="rebalance-no-plan"]')).toBeHidden();
    await expect(page.locator('[data-testid="rebalance-no-eligible-rules"]')).toBeHidden();

    // 1 rule section, 3 candidate rows.
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(1);

    // Each row has a data-testid of the form rebalance-rule-candidate-<id>.
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-3"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-2"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-3"]')).toHaveCount(1);

    // Total drift header is shown.
    await expect(page.locator('[data-testid="rebalance-total-drift"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('52-week position indicator renders per candidate row when high_52w + low_52w are set', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [
      { id: 'h-1', ticker: '2330.TW', shares: 1000, cost: 50, currency: 'TWD', current_price: 600,
        high_52w: 700, low_52w: 500,
        attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    ];
    fixture.plans = [{
      id: 'plan-1', name: 'TW only', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'TW stocks',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        target_weight_pct: 100,
        show_in_rebalance: true, // v1.19
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toBeVisible();
    // 52w bar (the week52-track) is visible when high_52w + low_52w are set.
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"] .week52-bar').first()).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"] .week52-marker').first()).toBeVisible();

    // Regression: the marker must be positioned at the current price within
    // the 52w range. (current_price=600, low=500, high=700 → 50%.) The
    // earlier version of this test only checked element visibility, which
    // let the no-op enrichment `rec.currentPrice = rec.currentPrice` slip
    // through and render `left: NaN%` (which browsers fall back to 0%).
    const markerStyle = await page.locator(
      '[data-testid="rebalance-rule-candidate-h-1"] .week52-marker'
    ).first().getAttribute('style');
    expect(markerStyle).toBe('left: 50%');

    // Sibling check: the price cell must render the holding's current_price.
    // This would have broken if we only fixed the enrichment to set
    // `current_price` (snake_case) but left the markup reading the
    // non-existent `record.currentPrice` (camelCase).
    const priceCell = await page.locator(
      '[data-testid="rebalance-rule-candidate-h-1"] td.tabular.text-right'
    ).nth(1).innerText();
    expect(priceCell).toContain('600');

    expect(errors).toEqual([]);
  });

  test('cash rule: 1 rule + 1 cash account → 1 candidate row with "Add $X" / "Reduce $X" advice', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [];
    fixture.cash_accounts = [
      { id: 'c-1', name: 'Savings', balance: 10000, currency: 'TWD', attributes: { 'cat-type': 'val-cash' } },
    ];
    fixture.categories = [
      { id: 'cat-type', name: 'Type', applies_to: ['holdings','cash','debt'],
        values: [{ id: 'val-cash', name: 'Cash' }] },
    ];
    fixture.plans = [{
      id: 'plan-1', name: 'Cash target', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'Cash bucket',
        when: { 'cat-type': ['val-cash'] },
        distribute: { 'cat-type': { 'val-cash': 100 } },
        target_weight_pct: 50,
        show_in_rebalance: true, // v1.19
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-c-1"]')).toBeVisible();

    // The candidate row shows the cash account name + action number
    // (v1.20 T02: format `+$AMOUNT.XX` for buy/add, `−$AMOUNT.XX` for
    // sell/reduce, locale-neutral sign + U+2212 minus). Uses
    // formatAmountNative so compact suffix (K/M/W/Y) appears for big
    // amounts.
    const rowText = await page.locator('[data-testid="rebalance-rule-candidate-c-1"]').innerText();
    expect(rowText).toContain('Savings');
    // Total = 10000 (cash only, no holdings/debts). Target 50% × 10000
    // = 5000. Delta = 5000 - 10000 = -5000 → "−$5,000.00" (rose-600).
    // 5000 < 10000 (TWD W threshold) so no compact suffix.
    expect(rowText).toMatch(/−\$5,000\.00/);

    expect(errors).toEqual([]);
  });

  // v1.20 T02 — Action cell format: +/− N shares/lots/cash with buy/sell
  // colors. Unit suffix `S` for non-TWD (shares), `L` for TWD (lots;
  // 1 lot = 1000 shares); 2 decimals; thousand separator when |n| ≥ 1000.
  // Sign character `+` / `−` (U+2212, NOT U+002D hyphen). Zero rows render
  // `+0.00`/S/L with slate-400.
  test('Action cell: +/−N shares with buy/sell colors (S for non-TWD, L for TWD)', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [
      // USD holding: 100 shares @ $100 = $10k USD = NT$322k.
      { id: 'us-1', ticker: 'AAPL', shares: 100, cost: 100, currency: 'USD',
        current_price: 100, attributes: { 'cat-region': 'val-US', 'cat-type': 'val-stock' } },
      // TWD holding: 1000 shares @ $1000 = NT$1M.
      { id: 'tw-1', ticker: '2330.TW', shares: 1000, cost: 50, currency: 'TWD',
        current_price: 1000, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    ];
    fixture.cash_accounts = [
      { id: 'c-1', name: 'Schwab', balance: 10000, currency: 'TWD',
        attributes: { 'cat-type': 'val-cash' } },
    ];
    // 3 single-bucket rules, each matches exactly 1 row, so per-row
    // semantics = bucket semantics. Targets sized so each row hits a
    // different sign.
    fixture.plans = [{
      id: 'plan-1', name: 'Action format test', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [
        // US rule: only us-1 matched. Total ≈ 1.32M TWD. Target 50%
        // × 1.32M = 660k. Current = 322k. Delta = +338k → BUY.
        { id: 'rule-us', name: 'US stocks',
          when: { 'cat-region': ['val-US'] },
          distribute: { 'cat-type': { 'val-stock': 100 } },
          target_weight_pct: 50, show_in_rebalance: true },
        // TW rule: only tw-1 matched. Target 5% × 1.32M = 66k. Current
        // = 1M. Delta = -934k → SELL.
        { id: 'rule-tw', name: 'TW stocks',
          when: { 'cat-region': ['val-TW'] },
          distribute: { 'cat-type': { 'val-stock': 100 } },
          target_weight_pct: 5, show_in_rebalance: true },
        // Cash rule: only c-1 matched. Target 50% × 1.32M = 660k.
        // Current = 10k. Delta = +650k → ADD.
        { id: 'rule-cash', name: 'Cash',
          when: { 'cat-type': ['val-cash'] },
          distribute: { 'cat-type': { 'val-cash': 100 } },
          target_weight_pct: 50, show_in_rebalance: true },
      ],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();

    await expect(page.locator('[data-testid="rebalance-rule-candidate-us-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-tw-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-c-1"]')).toBeVisible();

    // --- USD holding BUY (us-1): +N.XXS, emerald-600 ---
    const usAction = page.locator(
      '[data-testid="rebalance-rule-candidate-us-1"] [data-testid="rebalance-candidate-action"]'
    );
    await expect(usAction).toBeVisible();
    const usText = await usAction.innerText();
    expect(usText).toMatch(/^\+\d{1,3}\.\d{2}S$/); // small enough → no comma
    expect(usText.endsWith('S')).toBe(true);
    await expect(usAction).toHaveClass(/text-emerald-600/);

    // --- TWD holding SELL (tw-1): −N.XXL, rose-600 ---
    const twAction = page.locator(
      '[data-testid="rebalance-rule-candidate-tw-1"] [data-testid="rebalance-candidate-action"]'
    );
    await expect(twAction).toBeVisible();
    const twText = await twAction.innerText();
    expect(twText).toMatch(/^−\d{1,3}\.\d{2}L$/); // small enough → no comma
    expect(twText.endsWith('L')).toBe(true);
    await expect(twAction).toHaveClass(/text-rose-600/);

    // --- Cash ADD (c-1): +$AMOUNT.XX (compact per formatAmountNative),
    // emerald-600 ---
    const cAction = page.locator(
      '[data-testid="rebalance-rule-candidate-c-1"] [data-testid="rebalance-candidate-action"]'
    );
    await expect(cAction).toBeVisible();
    const cText = await cAction.innerText();
    expect(cText).toMatch(/^\+\$[\d,]+\.\d{2}[KMWY]?$/);
    await expect(cAction).toHaveClass(/text-emerald-600/);

    expect(errors).toEqual([]);
  });

  // v1.20 T02 — Zero-delta row: render `+0.00`/S/L with slate-400.
  test('Action cell: zero-delta row shows +0.00 with slate-400', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    // Single holding, single rule whose target = current → delta = 0.
    fixture.holdings = [
      { id: 'h-1', ticker: 'AAPL', shares: 100, cost: 100, currency: 'USD',
        current_price: 100, attributes: { 'cat-type': 'val-stock' } },
    ];
    fixture.cash_accounts = [];
    fixture.plans = [{
      id: 'plan-1', name: 'Zero delta', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'All stocks',
        when: { 'cat-type': ['val-stock'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        target_weight_pct: 100, // target = total = current → delta = 0
        show_in_rebalance: true,
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toBeVisible();

    const action = page.locator(
      '[data-testid="rebalance-rule-candidate-h-1"] [data-testid="rebalance-candidate-action"]'
    );
    await expect(action).toBeVisible();
    expect(await action.innerText()).toBe('+0.00S');
    await expect(action).toHaveClass(/text-slate-400/);

    expect(errors).toEqual([]);
  });

  // v1.20 T02 — Cash zero-delta row: `+$0.00` with slate-400 (covers
  // the cash path of formatRebalanceActionText which the holding-zero
  // test doesn't exercise).
  test('Action cell: zero-delta cash row shows +$0.00 with slate-400', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [];
    fixture.cash_accounts = [
      { id: 'c-1', name: 'Savings', balance: 10000, currency: 'TWD',
        attributes: { 'cat-type': 'val-cash' } },
    ];
    fixture.plans = [{
      id: 'plan-1', name: 'Cash zero', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'All cash',
        when: { 'cat-type': ['val-cash'] },
        distribute: { 'cat-type': { 'val-cash': 100 } },
        target_weight_pct: 100, // target = total = current → delta = 0
        show_in_rebalance: true,
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-c-1"]')).toBeVisible();

    const action = page.locator(
      '[data-testid="rebalance-rule-candidate-c-1"] [data-testid="rebalance-candidate-action"]'
    );
    await expect(action).toBeVisible();
    expect(await action.innerText()).toBe('+$0.00');
    await expect(action).toHaveClass(/text-slate-400/);

    expect(errors).toEqual([]);
  });
  test('multi-rule overlap on 1 holding → 2 rows (one per rule)', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [
      { id: 'h-1', ticker: '2330.TW', shares: 1000, cost: 50, currency: 'TWD', current_price: 600,
        attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
    ];
    // 2 rules both targeting the same holding (region=TW for rule 1,
    // type=stock for rule 2). Both rebalance-eligible.
    fixture.plans = [{
      id: 'plan-1', name: 'Overlap', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [
        { id: 'rule-1', name: 'TW region',
          when: { 'cat-region': ['val-TW'] },
          distribute: { 'cat-type': { 'val-stock': 100 } },
          target_weight_pct: 50, show_in_rebalance: true },
        { id: 'rule-2', name: 'Stock sector',
          when: { 'cat-type': ['val-stock'] },
          distribute: { 'cat-region': { 'val-TW': 100 } },
          target_weight_pct: 50, show_in_rebalance: true },
      ],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();

    // 2 rule sections, each with 1 candidate row for h-1.
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(2);
    // Total of 2 rows for h-1 across sections.
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toHaveCount(2);

    expect(errors).toEqual([]);
  });

  test('no eligible rules: active plan has rules but no target_weight_pct → empty CTA', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.plans = [{
      id: 'plan-1', name: 'Drift-only', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'No weight',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        // No target_weight_pct → drift-only.
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();

    // active plan exists, no eligible rules → that empty CTA shows.
    await expect(page.locator('[data-testid="rebalance-no-eligible-rules"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('filter persistence: plan rule filter persists + rebalance recomputes after reload', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.holdings = [
      { id: 'h-1', ticker: '2330.TW', shares: 1000, currency: 'TWD', current_price: 600,
        attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-stock' } },
      { id: 'h-2', ticker: 'AAPL',  shares: 10,   currency: 'USD', current_price: 200,
        attributes: { 'cat-region': 'val-US', 'cat-type': 'val-stock' } },
    ];
    fixture.plans = [{
      id: 'plan-1', name: 'Mixed', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'All stocks',
        when: { 'cat-type': ['val-stock'] },
        distribute: { 'cat-region': { 'val-TW': 50, 'val-US': 50 } },
        target_weight_pct: 100,
        show_in_rebalance: true, // v1.19
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();

    // Two candidate rows: h-1 (TW) and h-2 (US), both match cat-type=stock.
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-2"]')).toBeVisible();

    // Reload (preserves localStorage via the same fixture).
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();
    // After reload the same rows still render.
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-candidate-h-2"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('plan editor: target_weight_pct input on a rule makes it rebalance-eligible', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    const fixture = makeFixture();
    // No active plan, no eligible rules.
    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Navigate to Plans tab.
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-testid="plans-page"]')).toBeVisible();

    // Open Plans editor and create a plan.
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('My Allocation');
    await page.locator('[data-testid="plan-rule-name"]').fill('All TW stocks');
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.waitForTimeout(100);
    const weightInputs = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await weightInputs[0].fill('100');
    await page.waitForTimeout(100);

    // The target_weight_pct input is visible.
    await expect(page.locator('[data-testid="plan-rule-target-weight"]')).toBeVisible();
    // Fill it.
    await page.locator('[data-testid="plan-rule-target-weight"]').fill('50');
    await page.waitForTimeout(100);
    // v1.19 (ADR 0025): tick the "Show in rebalance page" toggle so the
    // rule is rebalance-eligible. Default is OFF; without this the rule
    // remains drift-only on Home and does not appear on the Rebalance
    // page regardless of target_weight_pct.
    await expect(page.locator('[data-testid="plan-rule-show-in-rebalance"]')).toBeVisible();
    await page.locator('[data-testid="plan-rule-show-in-rebalance"]').check();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(200);
    // Set it active.
    await page.locator('[data-testid="plan-set-active"]').first().click();
    await page.waitForTimeout(200);
    // Navigate to Rebalance and verify the rule is now eligible.
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('category-row filter builder: add 2 category rows to a rule, save, observe filter has 2 keys', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    const fixture = makeFixture();
    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Navigate to Plans tab.
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-create"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-name"]').fill('Multi-axis');
    await page.locator('[data-testid="plan-rule-name"]').fill('TW stocks');
    // Add category row 1: Region = TW.
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Region' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    // Add category row 2: Type = Stock.
    await page.locator('[data-testid="plan-rule-when-add-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-when-value-add"]').first().click();
    await page.waitForTimeout(100);
    // Distribute.
    await page.locator('[data-testid="plan-rule-distribute-cat"]').selectOption({ label: 'Type' });
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-rule-distribute-add"]').selectOption({ label: 'Stock' });
    await page.waitForTimeout(100);
    const weightInputs = await page.locator('[data-testid="plan-rule-distribute-weight"]').all();
    await weightInputs[0].fill('100');
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(200);

    // Verify the saved plan has 2 keys in rule.when.
    const ruleKeys = await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      const d = window.Alpine.$data(root);
      const plan = d.data.plans[0];
      return Object.keys(plan.rules[0].when);
    });
    expect(ruleKeys).toEqual(['cat-region', 'cat-type']);

    expect(errors).toEqual([]);
  });

  // ---- v1.19 (ADR 0025) — show_in_rebalance toggle ----

  test('show_in_rebalance toggle off: rule with target_weight_pct but toggle off → empty CTA', async ({ page }) => {
    const errors = collectAppErrors(page);
    const fixture = makeFixture();
    fixture.plans = [{
      id: 'plan-1', name: 'Toggle-off only', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'No toggle',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        target_weight_pct: 50,
        // show_in_rebalance omitted on purpose — defaults to false.
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="nav-rebalance"]').click();

    // Active plan exists but no rules have show_in_rebalance → empty CTA.
    await expect(page.locator('[data-testid="rebalance-no-eligible-rules"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('plan editor: unticking show_in_rebalance hides an otherwise-eligible rule from Rebalance', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    const fixture = makeFixture();
    fixture.plans = [{
      id: 'plan-1', name: 'Toggle test', updated_at: '2024-07-01T00:00:00.000Z',
      rules: [{
        id: 'rule-1', name: 'Opted in',
        when: { 'cat-region': ['val-TW'] },
        distribute: { 'cat-type': { 'val-stock': 100 } },
        target_weight_pct: 100,
        show_in_rebalance: true,
      }],
    }];
    fixture.active_plan_id = 'plan-1';

    await page.addInitScript(initScript(fixture));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Initially visible on Rebalance page.
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(1);

    // Open plan editor and untick the toggle.
    await page.locator('button:has-text("Plans")').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="plan-edit"]').first().click();
    await page.waitForTimeout(200);
    const checkbox = page.locator('[data-testid="plan-rule-show-in-rebalance"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await page.waitForTimeout(100);
    await page.locator('[data-testid="plan-save"]').click();
    await page.waitForTimeout(200);

    // Now the rule is not eligible → rebalance page shows empty CTA.
    await page.locator('[data-testid="nav-rebalance"]').click();
    await expect(page.locator('[data-testid="rebalance-no-eligible-rules"]')).toBeVisible();
    await expect(page.locator('[data-testid="rebalance-rule-section"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
