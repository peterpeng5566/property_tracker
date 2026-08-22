// tests/browser/drift-amounts.spec.js — Playwright browser smoke for
// the v1.17 Home "Plan vs Actual" amount columns + section header.
//
// Run: stage 4 of ./scripts/safety-net.sh.
//
// Companion to drift-report.spec.js (v1.4 % columns). This file covers
// the v1.17 extension:
//   - 7-column desktop table (3 new $-columns on the right)
//   - Per-card 3-line header (Matching | Target | Δ in $)
//   - Section header: Σ target + Σ weight + over-100% warning
//   - 0-matching edge case shows red $ + em-dash %
//   - Debt records produce negative actual$
//   - Treat-missing-as-100 for rules with no target_weight_pct
//
// Wiring: same as drift-report.spec.js (localStorage STORAGE_KEY +
// page.addInitScript). Each test gets its own focused fixture to keep
// assertions readable.

'use strict';

const { test, expect } = require('@playwright/test');
const { collectAppErrors } = require('./_helpers');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Base categories used across fixtures. 2 categories (country + type)
// × 2 values each — matches the v1.4 drift-report.spec.js shape so
// there's a single shared mental model.
const CATEGORIES = [
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
];

// Fixture A: 1 TWD holding $200,000 with type=stock; 1 rule distribute
// {stock: 60, bond: 40} × target_weight_pct 50. Exercises a clean
// amount-math case:
//   - net worth = 200K TWD
//   - rule_target = 100K (50%); stock=60K, bond=40K
//   - actual: stock=200K (record matches), bond=0
//   - drift: stock=+140K, bond=-40K
function makeFixtureAmountMath() {
  return {
    version: '1.1',
    holdings: [
      {
        id: 'h-stock', ticker: '2330.TW', shares: 200, cost: 500,
        currency: 'TWD', current_price: 1000,
        attributes: { 'cat-country': 'val-TW', 'cat-type': 'val-stock' },
      },
    ],
    cash_accounts: [],
    debts: [],
    categories: CATEGORIES,
    snapshots: [],
    plans: [{
      id: 'plan-amount',
      name: 'Amount math',
      rules: [
        {
          id: 'rule-stockbond', name: 'Stock/Bond 60/40',
          when: {},
          distribute: { 'cat-type': { 'val-stock': 60, 'val-bond': 40 } },
          target_weight_pct: 50,
        },
      ],
    }],
    active_plan_id: 'plan-amount',
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
      device_id: 'drift-amounts-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

// Fixture B: rule WITHOUT target_weight_pct set (treat-missing-as-100
// on Home per ADR 0024 §2). Card header target must equal net worth
// (100% of portfolio). Note: Σ target across rules is tested in the
// over-weight fixture, not here — this fixture exercises the single-
// rule card-header rendering with one rule.
function makeFixtureMissingWeight() {
  return {
    version: '1.1',
    holdings: [
      {
        id: 'h-twstock', ticker: '2330.TW', shares: 1000, cost: 50,
        currency: 'TWD', current_price: 600,
        attributes: { 'cat-country': 'val-TW', 'cat-type': 'val-stock' },
      },
    ],
    cash_accounts: [],
    debts: [],
    categories: CATEGORIES,
    snapshots: [],
    plans: [{
      id: 'plan-missing',
      name: 'Missing weight',
      rules: [
        {
          id: 'rule-tw', name: 'TW sleeve (no weight set)',
          when: { 'cat-country': ['val-TW'] },
          distribute: { 'cat-type': { 'val-stock': 70, 'val-bond': 30 } },
          // target_weight_pct omitted on purpose — ADR 0024 §2 says
          // treat missing as 100% on Home.
        },
      ],
    }],
    active_plan_id: 'plan-missing',
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
      device_id: 'drift-missing-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

// Fixture C: 2 rules each target_weight_pct 60 → Σ = 120 → over-100%.
function makeFixtureOverWeight() {
  const f = makeFixtureAmountMath();
  f.plans[0].rules.push({
    id: 'rule-over', name: 'Overweight rule',
    when: { 'cat-country': ['val-US'] },
    distribute: { 'cat-type': { 'val-stock': 100 } },
    target_weight_pct: 60,
  });
  // Σ = 50 + 60 = 110% — wait that's 110%, not 120%. Adjust the first
  // rule's weight so Σ clearly exceeds 100:
  f.plans[0].rules[0].target_weight_pct = 60;
  // Σ = 60 + 60 = 120%
  f.plans[0].name = 'Overweight plan';
  return f;
}

// Fixture D: rule with target_weight_pct set + no matching records.
// Exercises ADR 0024 §4 edge case: delta$ red, delta% em-dash.
function makeFixtureZeroMatchAmount() {
  return {
    version: '1.1',
    holdings: [
      {
        id: 'h-unrelated', ticker: 'OTHER', shares: 100, cost: 50,
        currency: 'TWD', current_price: 100,
        attributes: { 'cat-country': 'val-TW', 'cat-type': 'val-stock' },
      },
    ],
    cash_accounts: [],
    debts: [],
    categories: CATEGORIES,
    snapshots: [],
    plans: [{
      id: 'plan-zero',
      name: 'Zero match',
      rules: [
        {
          id: 'rule-us', name: 'US sleeve (no US records)',
          when: { 'cat-country': ['val-US'] },
          distribute: { 'cat-type': { 'val-stock': 60, 'val-bond': 40 } },
          target_weight_pct: 50,
        },
      ],
    }],
    active_plan_id: 'plan-zero',
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
      device_id: 'drift-zero-test-device',
      last_synced_at: null,
      created_at: '2024-07-01T00:00:00.000Z',
    },
  };
}

// Fixture E: 1 debt record + 1 rule that matches it. Per ADR 0024 §5,
// debt records contribute negative actual_amount. The rule is still
// "matched" (the debt has attributes), but its value goes negative.
function makeFixtureDebtNegative() {
  return {
    version: '1.1',
    holdings: [],
    cash_accounts: [],
    debts: [
      {
        id: 'd-mortgage', name: 'Mortgage',
        currency: 'TWD', balance: 1_000_000,
        attributes: { 'cat-type': 'val-bond' },
      },
    ],
    categories: CATEGORIES,
    snapshots: [],
    plans: [{
      id: 'plan-debt',
      name: 'Debt plan',
      rules: [
        {
          id: 'rule-all', name: 'All bond targets',
          when: {},
          distribute: { 'cat-type': { 'val-bond': 100 } },
          target_weight_pct: 100,
        },
      ],
    }],
    active_plan_id: 'plan-debt',
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
      device_id: 'drift-debt-test-device',
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

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

test.describe('portfolio.html drift amounts (v1.17 ticket 02)', () => {
  test('amount columns render with correct math (target / actual / drift $)', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureAmountMath()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Net worth = 200K TWD, rule_target = 50% × 200K = 100K TWD,
    // stock = 60% × 100K = 60K, bond = 40% × 100K = 40K.
    // Actual: stock row gets 200K (the holding matches); bond gets 0.
    // Drift: stock = +140K, bond = -40K.
    const card = page.locator('[data-testid=drift-card]');
    await expect(card).toHaveCount(1);

    // Stock row.
    const stockTarget = card.locator('[data-testid=drift-target-amt-val-stock]');
    const stockActual = card.locator('[data-testid=drift-actual-amt-val-stock]');
    const stockDrift = card.locator('[data-testid=drift-drift-amt-val-stock]');
    await expect(stockTarget).toBeVisible();
    await expect(stockActual).toBeVisible();
    await expect(stockDrift).toBeVisible();
    await expect(stockTarget).toHaveText('$6.00W');
    await expect(stockActual).toHaveText('$20.00W');
    await expect(stockDrift).toHaveText('+$14.00W');

    // Bond row.
    const bondTarget = card.locator('[data-testid=drift-target-amt-val-bond]');
    const bondActual = card.locator('[data-testid=drift-actual-amt-val-bond]');
    const bondDrift = card.locator('[data-testid=drift-drift-amt-val-bond]');
    await expect(bondTarget).toHaveText('$4.00W');
    await expect(bondActual).toHaveText('$0.00');
    await expect(bondDrift).toHaveText('-$4.00W');

    // Per ADR 0024 §4: delta% and delta$ share the same drift_class.
    // Here stock drift (+140K) > 5pp threshold (in %) → both red.
    const stockDeltaPct = card.locator('[data-testid=drift-delta-val-stock]');
    await expect(stockDeltaPct).toHaveClass(/text-red-600/);
    await expect(stockDrift).toHaveClass(/text-red-600/);

    expect(errors).toEqual([]);
  });

  test('treat-missing-as-100: rule with no target_weight_pct → card header Target = netWorth', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureMissingWeight()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Net worth = 1000 × 600 = 600K TWD (single holding).
    // Rule has no target_weight_pct → treat as 100 → rule_target = 600K.
    const card = page.locator('[data-testid=drift-card]');
    await expect(card).toHaveCount(1);

    // Card header Target line (data-testid="drift-card-target-amount").
    const targetLine = card.locator('[data-testid=drift-card-target-amount]');
    await expect(targetLine).toBeVisible();
    await expect(targetLine).toHaveText('$60.00W');

    expect(errors).toEqual([]);
  });

  test('0-matching rule: delta$ is red, delta% is em-dash (ADR 0024 §4 edge case)', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureZeroMatchAmount()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Single rule, no US records. Rule has target_weight_pct=50;
    // net worth = 100 × 100 = 10K TWD; rule_target = 5K.
    // Per vid: stock=3K (60%), bond=2K (40%).
    // 0-matching → actual_amount={}, drift_amount=-target_amount per vid.
    const card = page.locator('[data-testid=drift-card]');
    await expect(card).toHaveCount(1);

    // delta% row: em-dash (no class, just slate text).
    const stockDeltaPct = card.locator('[data-testid=drift-delta-val-stock]');
    await expect(stockDeltaPct).toHaveText('—');
    // delta$ row: red (ADR 0024 §4 edge case — $ shows the missed target).
    const stockDeltaAmt = card.locator('[data-testid=drift-drift-amt-val-stock]');
    await expect(stockDeltaAmt).toBeVisible();
    await expect(stockDeltaAmt).toHaveClass(/text-red-600/);
    await expect(stockDeltaAmt).toHaveText('-$3,000.00');

    expect(errors).toEqual([]);
  });

  test('debt record contributes negative actual$ (ADR 0024 §5)', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureDebtNegative()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Single debt $1M TWD with type=bond; rule distribute {bond: 100},
    // target_weight_pct=100.
    // Net worth = 0 − 1M = −1M TWD.
    // rule_target = −1M (negative net worth; ADR 0024 §1).
    // bond target_amount = −1M × 100% = −1M.
    // actual_amount: debt contributes -1M (negative). bond = -1M.
    // drift = actual - target = -1M − (-1M) = 0.
    const card = page.locator('[data-testid=drift-card]');
    await expect(card).toHaveCount(1);

    const bondActual = card.locator('[data-testid=drift-actual-amt-val-bond]');
    await expect(bondActual).toBeVisible();
    await expect(bondActual).toHaveText('-$100.00W');

    const bondTarget = card.locator('[data-testid=drift-target-amt-val-bond]');
    await expect(bondTarget).toHaveText('-$100.00W');

    expect(errors).toEqual([]);
  });

  test('Σ target over-100% warning fires when sum of rule weights > 100', async ({ page }) => {
    const errors = collectAppErrors(page);
    page.on('dialog', async (d) => { await d.accept(); });
    await page.addInitScript(initScript(makeFixtureOverWeight()));
    await page.goto('/portfolio.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Section header: Σ target = (60% + 60%) × 200K = 240K TWD.
    // Σ weight = 60% + 60% = 120%.
    // Warning fires (text-rose-600) with i18n string.
    const summary = page.locator('[data-testid=drift-section-summary]');
    await expect(summary).toBeVisible();
    const weight = page.locator('[data-testid=drift-section-total-weight]');
    await expect(weight).toHaveText('120.0%');
    const warning = page.locator('[data-testid=drift-section-over-weight-warning]');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveClass(/text-rose-600/);

    expect(errors).toEqual([]);
  });
});