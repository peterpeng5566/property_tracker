// tests/browser/exposure.spec.js — Playwright browser smoke for the v1.21
// Home Exposure card + Categories "Default categories" section + Debts
// card hiding. See `.scratch/v1.21-home-exposure-card/issues/04`.
//
// Run: stage 4 of `./scripts/safety-net.sh`.
//
// What it covers (ticket 04 / spec §Test plan):
//   1.  Default Exposure is present after first load (Categories page).
//   2.  Number input UX — change 1x to 3 → name becomes '3x'.
//   3.  Add / delete a default value via the form.
//   4.  Exposure card shows 100% when no records tagged.
//   5.  Exposure card reflects multipliers (2x + 0x → 133.3%).
//   6.  Exposure card hides when 0 holdings + 0 cash.
//   7.  Debts card hides at 0 + Net Worth sub-line trimmed (no "0 debts" tail).
//   8.  Debts card reappears when a debt is added.
//   9.  Group By section on Home includes the Default Exposure category.
//  10.  i18n round-trip — new strings render in zh.
//
// Calculation correctness for the weighted-average multiplier (e.g. 133.3%)
// is pinned by `tests/exposure.test.js` (lib/exposure.js unit suite). These
// scenarios assert the *integration*: Alpine shim → lib → DOM render, the
// round-trip through `data-testid` selectors, and the i18n bundle parity.
//
// Same error-collection discipline as categories-guard.spec.js — favicon
// 404 / CDN noise / Alpine transition races are pre-existing (see
// tests/browser/backups.spec.js for the canonical list).

'use strict';

const { test, expect } = require('@playwright/test');

const { cleanRoutes, collectAppErrors } = require('./_helpers');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

// Stable value ids seeded by lib/exposure.js at load time.
const DEFAULT_EXPOSURE_ID = 'cat-default-exposure';
const VAL_0X = 'val-default-0x';
const VAL_1X = 'val-default-1x';
const VAL_2X = 'val-default-2x';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

function emptyFixture() {
  return {
    version: '1.1',
    holdings: [],
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
      fx_rate: 32.2,
      snapshot_cap: 365,
    },
    meta: {
      device_id: 'exposure-smoke-device',
      last_synced_at: null,
      created_at: '2025-01-01T00:00:00.000Z',
    },
  };
}

// Fixture with one untagged holding (no exposure attribute). The Default
// Exposure category is left empty in categories[] so the load-time
// ensureDefaultCategories is the single seed source. The $100 value is
// below the TWD compact-suffix threshold (10,000) so it renders as
// "$100.00" verbatim — easier to assert against in the subline.
function untaggedHoldingFixture() {
  const f = emptyFixture();
  f.holdings = [{
    id: 'h-untagged',
    ticker: '2330.TW',
    shares: 1,
    cost: 50,
    currency: 'TWD',
    current_price: 100,  // 1 × $100 = $100 TWD total
    attributes: {},
  }];
  return f;
}

// Fixture for the multi-bucket scenario: $100 holding @ 2x + $50 cash @ 0x.
// Per T04 spec §Test plan, scenario 5: math is (2×100 + 0×50) / (100+50)
// = 200/150 = 1.333… → 133.3%. Subline pct-of-top-3: 2x = 66.7%, 0x = 33.3%.
function mixedBucketsFixture() {
  const f = emptyFixture();
  f.holdings = [{
    id: 'h-2x',
    ticker: '2330.TW',
    shares: 1,
    cost: 50,
    currency: 'TWD',
    current_price: 100,  // 1 × $100 = $100 TWD
    attributes: { [DEFAULT_EXPOSURE_ID]: VAL_2X },
  }];
  f.cash_accounts = [{
    id: 'c-0x',
    name: 'Cash @ 0x',
    balance: 50,
    currency: 'TWD',  // $50 TWD
    attributes: { [DEFAULT_EXPOSURE_ID]: VAL_0X },
  }];
  return f;
}

function addOneHoldingAndOneCashFixture() {
  // For the Debts-hide scenarios. One holding + one cash, no debts.
  const f = emptyFixture();
  f.holdings = [{
    id: 'h-1',
    ticker: 'AAPL',
    shares: 1,
    cost: 1,
    currency: 'TWD',
    current_price: 100,
    attributes: {},
  }];
  f.cash_accounts = [{
    id: 'c-1',
    name: 'Savings',
    balance: 100,
    currency: 'TWD',
    attributes: {},
  }];
  return f;
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
  `;
}

async function gotoAndWaitForAlpine(page) {
  await page.goto('/portfolio.html');
  await page.waitForFunction(() => !!window.Alpine, { timeout: 10_000 });
  // Tiny settle so Alpine finishes rendering x-for templates.
  await page.waitForTimeout(300);
}

async function navigateToCategories(page) {
  await page.locator('button:has-text("Categories")').first().click();
  await page.waitForTimeout(200);
}

async function readStored(page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 1 — Default Exposure is present after first load
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Default Exposure card is present after first load (auto-seeded by ensureDefaultCategories)', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(emptyFixture()));
  await gotoAndWaitForAlpine(page);
  await navigateToCategories(page);

  // Default categories section header is visible.
  await expect(page.locator('h2:has-text("Default categories")')).toBeVisible();

  // The Default Exposure card is rendered.
  const defaultCard = page.locator(`[data-testid="default-category-${DEFAULT_EXPOSURE_ID}"]`);
  await expect(defaultCard).toBeVisible();
  await expect(defaultCard.locator('span.font-medium')).toHaveText('Exposure');

  // Applies-to: read-only text reads "Applies to: Holdings, Cash" (built
  // from the existing appliesToHoldings + appliesToCash i18n keys).
  await expect(defaultCard).toContainText('Applies to:');
  await expect(defaultCard).toContainText('Holdings');
  await expect(defaultCard).toContainText('Cash');

  // Three seeded values exist: 0x, 1x, 2x — each as a number input.
  await expect(page.locator(`[data-testid="default-value-input-${VAL_0X}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="default-value-input-${VAL_1X}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="default-value-input-${VAL_2X}"]`)).toBeVisible();

  // Each input pre-fills with its parsed multiplier (0 / 1 / 2).
  await expect(page.locator(`[data-testid="default-value-input-${VAL_0X}"]`)).toHaveValue('0');
  await expect(page.locator(`[data-testid="default-value-input-${VAL_1X}"]`)).toHaveValue('1');
  await expect(page.locator(`[data-testid="default-value-input-${VAL_2X}"]`)).toHaveValue('2');

  // Hints — the read-only note renders in English.
  await expect(defaultCard).toContainText('System category');

  // No "Delete category" button on the default card (only on user cards).
  await expect(defaultCard.locator('button[title="Delete category"]')).toHaveCount(0);

  // localStorage round-trip — Default Exposure was persisted by save().
  const stored = await readStored(page);
  const seeded = stored.categories.find((c) => c.id === DEFAULT_EXPOSURE_ID);
  expect(seeded, 'Default Exposure category should be in localStorage after load + save').toBeTruthy();
  expect(seeded.isDefault).toBe(true);
  expect(seeded.applies_to).toEqual(['holdings', 'cash']);
  expect(seeded.values.map((v) => v.name).sort()).toEqual(['0x', '1x', '2x']);

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 2 — Number input UX: 1x → 3 (stored name becomes '3x')
// ──────────────────────────────────────────────────────────────────────

test('v1.21: number input on Default Exposure — typing 3 writes name as "3x"', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(emptyFixture()));
  await gotoAndWaitForAlpine(page);
  await navigateToCategories(page);

  // Drive the change through the DOM (matching real user behaviour). The
  // @change handler invokes setDefaultValueName(catId, valId, value, inputEl)
  // — when the user blurs the input.
  const input = page.locator(`[data-testid="default-value-input-${VAL_1X}"]`);
  await expect(input).toHaveValue('1');
  // Playwright's .fill() dispatches input + change automatically; no need
  // to fire them manually.
  await input.fill('3');
  await input.blur();
  await page.waitForTimeout(200);

  // The DOM input stays at 3 (number-only — the "x" is a separate span).
  await expect(input).toHaveValue('3');

  // The companion "x" glyph is still visible to the right of the input.
  // The card structure is <input> <span x-text="'x'"> <button "×">; the
  // span sits between the input and the delete button. assert via the
  // structural relationship so a swap to a single read-only text doesn't
  // silently break this test.
  const xSpan = input.locator('xpath=following-sibling::span[1]');
  await expect(xSpan).toHaveText('x');

  // The Alpine shim wrote back the stored name as '3x'. Persist + re-read.
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).save();
  });
  const stored = await readStored(page);
  const seeded = stored.categories.find((c) => c.id === DEFAULT_EXPOSURE_ID);
  const val = seeded.values.find((v) => v.id === VAL_1X);
  expect(val.name).toBe('3x');

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 3 — Add / delete a default value
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Add Value button on Default Exposure adds 1x; × button removes it', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(emptyFixture()));
  await gotoAndWaitForAlpine(page);
  await navigateToCategories(page);

  // Initial seeded count = 3 values.
  const card = page.locator(`[data-testid="default-category-${DEFAULT_EXPOSURE_ID}"]`);
  const addBtn = card.locator('button:has-text("+ Add Value")');
  await expect(addBtn).toBeVisible();

  // Add a value.
  await addBtn.click();
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).save();
  });
  let stored = await readStored(page);
  let seeded = stored.categories.find((c) => c.id === DEFAULT_EXPOSURE_ID);
  expect(seeded.values.length).toBe(4);
  // New value name defaults to '1x' (see addDefaultValue in portfolio.html).
  const newVal = seeded.values.find((v) => v.id !== VAL_0X && v.id !== VAL_1X && v.id !== VAL_2X);
  expect(newVal).toBeTruthy();
  expect(newVal.name).toBe('1x');

  // Delete the 0x value.
  await page.locator(`[data-testid="default-value-del-${VAL_0X}"]`).click();
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).save();
  });
  stored = await readStored(page);
  seeded = stored.categories.find((c) => c.id === DEFAULT_EXPOSURE_ID);
  expect(seeded.values.length).toBe(3);
  expect(seeded.values.some((v) => v.id === VAL_0X)).toBe(false);
  // 1x and 2x survive intact.
  expect(seeded.values.some((v) => v.id === VAL_1X && v.name === '1x')).toBe(true);
  expect(seeded.values.some((v) => v.id === VAL_2X && v.name === '2x')).toBe(true);

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 4 — Exposure card shows 100% when no records tagged
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Home Exposure card shows 100.0% when no holdings/cash carry an exposure attribute', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(untaggedHoldingFixture()));
  await gotoAndWaitForAlpine(page);

  // Exposure card is visible.
  const card = page.locator('[data-testid="summary-exposure"]');
  await expect(card).toBeVisible();

  // Headline = 100.0% (1 decimal always shown — ADR 0028 §4).
  // Card structure: <p label> <p headline> <p subline>. Headline is the
  // first <p> after the label.
  const headline = card.locator('p.text-3xl');
  await expect(headline).toHaveText('100.0%');

  // Subline: all records land in the Unassigned bucket (100% of top-3).
  // The fixture's single holding totals $100 TWD (1 share × $100) →
  // renders as "$100.00" (TWD below the 10,000 W-suffix threshold).
  // The label also matches p.text-xs.text-slate-500, so the subline is
  // .last() within the card.
  const subline = card.locator('p.text-xs.text-slate-500').last();
  await expect(subline).toContainText('Unassigned');
  await expect(subline).toContainText('$100.00');
  await expect(subline).toContainText('(100.0%)');

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 5 — Exposure card reflects multipliers (133.3%)
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Home Exposure card reflects weighted-average multiplier (2x + 0x → 133.3%)', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(mixedBucketsFixture()));
  await gotoAndWaitForAlpine(page);

  const card = page.locator('[data-testid="summary-exposure"]');
  await expect(card).toBeVisible();

  // Per T04 spec §5: math is (2×100 + 0×50) / (100+50) = 200/150 ≈ 1.333.
  // × 100 = 133.333… → toFixed(1) = '133.3%'.
  const headline = card.locator('p.text-3xl');
  await expect(headline).toHaveText('133.3%');

  // Subline: buckets sorted by multiplier desc, share = percent of top-3 sum.
  //   2x: 100 / 150 × 100 = 66.666… → '66.7%'
  //   0x:  50 / 150 × 100 = 33.333… → '33.3%'
  // Joined by ' · ', 2x first (higher multiplier).
  const subline = card.locator('p.text-xs.text-slate-500').last();
  const sublineText = await subline.textContent();
  expect(sublineText).toContain('2x: $100.00');
  expect(sublineText).toContain('(66.7%)');
  expect(sublineText).toContain('0x: $50.00');
  expect(sublineText).toContain('(33.3%)');
  // 2x must appear before 0x in the rendered subline (sorted by multiplier desc).
  expect(sublineText.indexOf('2x:')).toBeLessThan(sublineText.indexOf('0x:'));

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 6 — Exposure card hides when there are 0 active records
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Exposure card is hidden when there are 0 active holdings AND 0 active cash', async ({ page }) => {
  const errors = collectAppErrors(page);
  // Empty fixture — no holdings, no cash, no debts.
  await page.addInitScript(initScript(emptyFixture()));
  await gotoAndWaitForAlpine(page);

  // Exposure card is hidden via x-show → not visible. Wait briefly for
  // the reactive hide to take effect (Alpine schedules after the initial
  // x-for settles).
  await page.waitForTimeout(300);
  const card = page.locator('[data-testid="summary-exposure"]');
  await expect(card).toBeHidden();

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 7 — Debts card hides at 0 + Net Worth sub-line trimmed
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Debts card is hidden at 0; Net Worth sub-line drops the "0 debts" tail', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(addOneHoldingAndOneCashFixture()));
  await gotoAndWaitForAlpine(page);

  // Debts card is hidden because totalDebts() === 0.
  const debtsCard = page.locator('[data-testid="summary-debts"]');
  await expect(debtsCard).toBeHidden();

  // Net Worth sub-line: should be "1 holdings, 1 cash" (the new
  // summary.netWorthSubNoDebts key in EN — no trailing "0 debts").
  // The card layout is <p label> <p headline> <p subline>; the subline
  // is `+ p + p` from the label (matches locale-agnostically — the label
  // text varies between EN/ZH).
  const subline = page
    .locator('p:has-text("Total Net Worth") + p + p')
    .first();
  await expect(subline).toHaveText('1 holdings, 1 cash');
  // Defensive: no "debts" anywhere in the trimmed subline.
  expect(await subline.textContent()).not.toMatch(/debt/i);

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 8 — Debts card reappears when a debt is added
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Debts card reappears when an active debt is added; sub-line includes the debt count', async ({ page }) => {
  const errors = collectAppErrors(page);
  const fixture = addOneHoldingAndOneCashFixture();
  await page.addInitScript(initScript(fixture));
  await gotoAndWaitForAlpine(page);

  // Drive a new debt through the Alpine shim (mirrors the v1.7 stamp-
  // trigger spec: drive the seam, not the form modal).
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    const data = window.Alpine.$data(root);
    data.data.debts.push({
      id: 'd-mortgage',
      name: 'Mortgage',
      balance: 500000,
      currency: 'TWD',
      inactive: false,
      attributes: {},
    });
    data.save();
  });
  await page.waitForTimeout(200);

  // Debts card is now visible.
  const debtsCard = page.locator('[data-testid="summary-debts"]');
  await expect(debtsCard).toBeVisible();

  // Headline shows the debt total in display currency (TWD).
  const debtsHeadline = debtsCard.locator('p.text-3xl');
  // $500,000 TWD → "500000" or "50.00W" per formatAmount. The fixture
  // value (500,000) is above the 10000 threshold so the compact suffix kicks in.
  // Either is acceptable; we just assert non-empty.
  expect((await debtsHeadline.textContent()).length).toBeGreaterThan(0);

  // Sub-line item count (1 debt). Use `+ p + p` from the label so the
  // match resolves the subline, not the label (both have the
  // text-xs text-slate-500 class).
  const debtsSub = page.locator('p:has-text("Debts") + p + p').first();
  await expect(debtsSub).toHaveText('1 debts');

  // Net Worth sub-line now uses the original summary.netWorthSub key
  // (with d=1) — the full "X holdings + Y cash − Z debts" form.
  const netWorthSub = page.locator('p:has-text("Total Net Worth") + p + p').first();
  await expect(netWorthSub).toHaveText('1 holdings + 1 cash − 1 debts');

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 9 — Group By section on Home includes the Default Exposure
// ──────────────────────────────────────────────────────────────────────

test('v1.21: Home Group By section includes the Default Exposure category card', async ({ page }) => {
  const errors = collectAppErrors(page);
  await page.addInitScript(initScript(mixedBucketsFixture()));
  await gotoAndWaitForAlpine(page);

  // Group By section is visible (groupByCategories has the seeded
  // Default Exposure plus any user categories — none here, so just one).
  const groupByHeader = page.locator('h2:has-text("Group by Category")').first();
  await expect(groupByHeader).toBeVisible();

  // The Default Exposure card is rendered with name "Exposure" + value
  // count "(3)" (the three seeded values).
  const exposureCardHeader = page.locator('h3:has-text("Exposure (3)")').first();
  await expect(exposureCardHeader).toBeVisible();

  // The 2x bucket holds the holding (1 share × $100 = $100 TWD); the 0x
  // bucket holds the $50 cash. Per-row assert the count + $-amount so
  // a future regression in lib/Group bucketing fails this test (the
  // text-only check above wouldn't catch a wrong-multiple bug).
  const cardBody = exposureCardHeader.locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]');
  await expect(cardBody).toContainText('2x');
  await expect(cardBody).toContainText('0x');

  const twoXRow = cardBody.locator('tr', { hasText: '2x' }).first();
  await expect(twoXRow).toContainText('$100.00');

  const zeroXRow = cardBody.locator('tr', { hasText: '0x' }).first();
  await expect(zeroXRow).toContainText('$50.00');

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Scenario 10 — i18n round-trip (zh)
// ──────────────────────────────────────────────────────────────────────

test('v1.21: i18n round-trip — Exposure card label, Default categories header, and hint render in zh', async ({ page }) => {
  const errors = collectAppErrors(page);
  const fixture = mixedBucketsFixture();
  fixture.settings.language = 'zh';
  await page.addInitScript(initScript(fixture));
  await gotoAndWaitForAlpine(page);

  // Home Exposure card label = "曝險" (the zh translation of summary.exposure).
  const card = page.locator('[data-testid="summary-exposure"]');
  await expect(card).toBeVisible();
  await expect(card.locator('p:has-text("曝險")')).toBeVisible();

  // Headline and subline still render in numeric form (locale-neutral),
  // not affected by language toggle — just pin the headline format.
  const headline = card.locator('p.text-3xl');
  await expect(headline).toHaveText('133.3%');

  // Navigate to Categories → "預設類別" header renders in zh.
  await navigateToCategories(page);
  await expect(page.locator('h2:has-text("預設類別")')).toBeVisible();

  // The read-only hint also renders in zh — full text per the spec
  // (not just a substring match, so a future hint shortening fails the
  // test rather than passing silently).
  const defaultCard = page.locator(`[data-testid="default-category-${DEFAULT_EXPOSURE_ID}"]`);
  await expect(defaultCard).toContainText('系統類別 — 名稱與適用範圍無法編輯');

  // Navigate back to Home via the Alpine shim — robust to nav-button label
  // changes. The Net Worth card label flips to "總資產 Net Worth" (the zh
  // catalog keeps a hybrid form rather than a pure translation — pinned
  // here so a future swap to a pure-ZH label is a deliberate choice, not
  // silent drift).
  await page.evaluate(() => {
    const root = document.querySelector('[x-data]');
    window.Alpine.$data(root).currentPage = 'home';
  });
  await page.waitForTimeout(150);

  // The Net Worth card is visible with its zh label "總資產 Net Worth".
  await expect(
    page.locator('div.bg-white:has(p:has-text("總資產"))').first()
  ).toBeVisible();

  // The no-debts subline uses summary.netWorthSubNoDebts = '{a} 筆持股、{c} 個現金帳戶'
  // in zh. The fixture has 1 holding + 1 cash + 0 debts → renders as
  // "1 筆持股、1 個現金帳戶". Locate via `+ p + p` from the bilingual
  // label so we resolve the subline, not the label (both share the
  // text-xs text-slate-500 class).
  const zhSub = page.locator('p:has-text("總資產") + p + p').first();
  const text = await zhSub.textContent();
  expect(text).toContain('筆持股');
  expect(text).toContain('個現金帳戶');
  // The English "debts" word from the with-debts key must NOT be in the
  // trimmed subline (guarantees the language toggled the subline key,
  // not just the visible label).
  expect(text).not.toMatch(/\bdebts\b/i);

  expect(errors).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// Teardown — clear routes to prevent cross-test pollution
// ──────────────────────────────────────────────────────────────────────

test.afterEach(async ({ page }) => {
  await cleanRoutes(page);
});
