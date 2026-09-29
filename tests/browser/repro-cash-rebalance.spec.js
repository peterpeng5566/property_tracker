// tests/browser/repro-cash-rebalance.spec.js — repro the user's bug
// (Current value / Target value in Rebalance section header are stale after
//  editing a cash account balance OR deleting a holding).
//
// The header is driven by `x-data="{ summary: getRebalanceSummaryText(ruleCandidate) }"`.
// Alpine evaluates x-data once at mount time and does NOT re-run it when
// the surrounding state changes, so `summary.current_str` and
// `summary.target_str` stay frozen at whatever the ruleCandidate looked
// like at first render. Per-row `x-text="formatAmountNative(record.currentValue, ...)"`
// IS reactive and updates correctly. This test reproduces the bug end to end.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

const STORAGE_KEY = 'property_tracker_portfolio_v1';

function loadUserData() {
  return JSON.parse(fs.readFileSync('/home/peter/portfolio_3.json', 'utf8'));
}

function initScript(fixture) {
  return `
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(fixture)}));
    window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
    window.PORTFOLIO_CONFIG.yahooProxyUrl = 'https://yahoo-proxy.repro.example.workers.dev/';
  `;
}

const collectErrors = (page) => {
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
    if (/tailwind|alpine\.js|googleapis|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
};

// Read the Current value / Target value shown in the nth
// rebalance-rule-section's HEADER (1-indexed). Scoped to the header div
// (`.flex.items-center.justify-between.mb-3`) so the table cell text
// below is not picked up.
async function readSectionHeaderByIndex(page, index) {
  return await page.evaluate((idx) => {
    const sections = document.querySelectorAll('[data-testid="rebalance-rule-section"]');
    const section = sections[idx - 1];
    if (!section) return null;
    const headerDiv = section.querySelector('.flex.items-center.justify-between.mb-3');
    if (!headerDiv) return null;
    const out = {};
    for (const span of headerDiv.querySelectorAll('span')) {
      const txt = (span.textContent || '').trim();
      if (txt === 'Current value' || txt === 'Target value') {
        const next = span.nextElementSibling;
        if (next) out[txt] = (next.textContent || '').trim();
      }
    }
    return out;
  }, index);
}

test('repro: edit 富邦 balance → Rebalance candidate row + section header update', async ({ page }) => {
  page.on('dialog', async (d) => { await d.accept(); });
  const errors = collectErrors(page);

  const fixture = loadUserData();
  await page.addInitScript(initScript(fixture));
  await page.goto('/portfolio.html');
  await page.waitForLoadState('domcontentloaded');

  await page.locator('[data-testid="nav-rebalance"]').click();
  await page.waitForTimeout(300);

  // Section 1 is the 現金 rule (insertion order).
  const headerBefore = await readSectionHeaderByIndex(page, 1);
  const rowBefore = (await page.locator(
    '[data-testid="rebalance-rule-candidate-cash-1786167901993-gzje"] td.tabular'
  ).first().innerText()).trim();

  // Go to Cash page, edit 富邦: 1,724,075 → 2,000,000.
  await page.locator('button:has-text("Cash")').first().click();
  await page.waitForTimeout(300);
  const c1Row = page.locator('tr', { hasText: '富邦' }).first();
  await c1Row.locator('button:has-text("Edit")').click();
  await page.waitForTimeout(200);
  const balanceInput = page.locator('input[x-model\\.number="cashForm.balance"]');
  await balanceInput.fill('2000000');
  await page.waitForTimeout(100);
  await page.locator('[x-show="showCashModal"] button[type="submit"]').click();
  await page.waitForTimeout(500);

  await page.locator('[data-testid="nav-rebalance"]').click();
  await page.waitForTimeout(500);

  const headerAfter = await readSectionHeaderByIndex(page, 1);
  const rowAfter = (await page.locator(
    '[data-testid="rebalance-rule-candidate-cash-1786167901993-gzje"] td.tabular'
  ).first().innerText()).trim();

  // Per-row updates correctly today (reactive x-text binding).
  expect(rowAfter).not.toBe(rowBefore);
  expect(rowAfter).toBe('$200.00W');

  // Section header is the bug: stale value stays in DOM even after
  // data changes.
  expect(headerBefore['Current value']).toBe('$384.90W');
  expect(headerBefore['Target value']).toBe('$270.20W');
  // Expected fresh values after the edit:
  //   New cash total = 2,000,000 + 11426.57×32.31 + 1,737,000 + 239×32.31 + 11,000
  //                  = 4,124,914.57 TWD ≈ $412.49W
  //   New portfolio total = 27,019,949 + (2,000,000 - 1,724,075) = 27,295,874 TWD
  //   Cash rule target = 10% × 27,295,874 ≈ $272.96W
  expect(headerAfter['Current value']).toBe('$412.49W');
  expect(headerAfter['Target value']).toBe('$272.96W');

  expect(errors).toEqual([]);
});

test('repro: delete a holding → Rebalance candidate section header for 台灣股票 updates', async ({ page }) => {
  page.on('dialog', async (d) => { await d.accept(); });
  const errors = collectErrors(page);

  const fixture = loadUserData();
  await page.addInitScript(initScript(fixture));
  await page.goto('/portfolio.html');
  await page.waitForLoadState('domcontentloaded');

  await page.locator('[data-testid="nav-rebalance"]').click();
  await page.waitForTimeout(300);

  // Section 2 is the 台灣股票 rule.
  const headerBefore = await readSectionHeaderByIndex(page, 2);

  // Delete the smallest TW holding (00719B.TWO with value 463,650 TWD ≈ $46.37W).
  await page.locator('button:has-text("Holdings")').first().click();
  await page.waitForTimeout(300);
  const targetRow = page.locator('tr', { hasText: '00719B.TWO' }).first();
  await targetRow.locator('button:has-text("Delete")').click();
  await page.waitForTimeout(500);

  await page.locator('[data-testid="nav-rebalance"]').click();
  await page.waitForTimeout(500);

  const headerAfter = await readSectionHeaderByIndex(page, 2);

  // Per-row for 00719B.TWO is now gone — sanity:
  await expect(page.locator(
    '[data-testid="rebalance-rule-candidate-h-1786843748447-z1mx"]'
  )).toHaveCount(0);

  // Section header is the bug: stale value stays in DOM even after
  // data changes. Pre-delete section header reads 5 stocks totalling
  // $1,199.06W; post-delete drops by $46.37W → $1,152.70W (11,526,950
  // TWD rounded to 2 decimals = 1,152.70).
  expect(headerBefore['Current value']).toBe('$1,199.06W');
  expect(headerAfter['Current value']).toBe('$1,152.70W');
  // Pre-delete section target = 45% × 27,019,949 = $1,215.90W. After
  // delete, total drops to 26,556,299 → 45% = $1,195.03W.
  expect(headerBefore['Target value']).toBe('$1,215.90W');
  expect(headerAfter['Target value']).toBe('$1,195.03W');

  expect(errors).toEqual([]);
});