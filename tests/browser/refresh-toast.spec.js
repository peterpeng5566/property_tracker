// tests/browser/refresh-toast.spec.js — Playwright browser smoke for v1.15
// refresh completion toast.
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright owns
// its own test discovery under playwright.config.ts testDir).
//
// What it covers (per .scratch/v1.15-refresh-toast/issues/01):
//   T1: refresh all-success → success toast appears with the count.
//   T2: refresh partial → warning toast + amber Retry button + row badge.
//   T3: refresh total-failure (proxy not configured) → rose banner, NO toast.
//   T4: refresh cancelled mid-flight → silent, NO toast.
//   T5: refresh on portfolio with 0 active holdings → silent, NO toast.
//   T6: retry-path toast reports the retry scope, not the whole portfolio.
//
// Implementation seam: the existing `data-testid="restore-toast"` element
// (portfolio.html:6294), driven by `window.__toast.show(msg, variant)`.
// The new v1.15 wiring fires `_showToast(...)` from `_applyRefreshResult`
// in portfolio.html. These tests pin the contract at the DOM seam only —
// no Alpine internals, no private methods.
//
// ADR 0022 codifies the feedback layer (success toast / partial warning
// toast + persistent amber button / error banner unchanged / cancel silent).

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';
const FALLBACK_PROXY_URL = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
const FALLBACK_PROXY_HOST = 'yahoo-proxy.smoke-test.example.workers.dev';

// Five-holding fixture used by T1, T2, T6. 3 USD + 2 TWD so the fixture
// also exercises mixed-currency refresh (no FX conversion in refresh path
// itself, but keeps the test realistic).
// Schema matches defaultPortfolio() in portfolio.html:3488 — `version: '1.1'`
// at top level, `meta.device_id` nested. holdings_order is additive.
const FIVE_HOLDINGS_FIXTURE = {
  version: '1.1',
  meta: {
    device_id: 'refresh-toast-smoke-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
  settings: {
    display_currency: 'TWD',
    language: 'en',
    cost_format: 'per_share',
    fx_source: 'manual',
    fx_rate: 32,
    fx_updated_at: '2025-01-01T00:00:00.000Z',
    snapshot_cap: 365,
  },
  holdings: [
    { id: 'h-aapl', ticker: 'AAPL', shares: 10, cost: 100, currency: 'USD', current_price: 0, high_52w: null, low_52w: null, prev_close: null, inactive: false, attributes: {}, category: null },
    { id: 'h-msft', ticker: 'MSFT', shares: 5, cost: 200, currency: 'USD', current_price: 0, high_52w: null, low_52w: null, prev_close: null, inactive: false, attributes: {}, category: null },
    { id: 'h-goog', ticker: 'GOOG', shares: 8, cost: 120, currency: 'USD', current_price: 0, high_52w: null, low_52w: null, prev_close: null, inactive: false, attributes: {}, category: null },
    { id: 'h-2330', ticker: '2330.TW', shares: 1000, cost: 500, currency: 'TWD', current_price: 0, high_52w: null, low_52w: null, prev_close: null, inactive: false, attributes: {}, category: null },
    { id: 'h-0050', ticker: '0050.TW', shares: 2000, cost: 100, currency: 'TWD', current_price: 0, high_52w: null, low_52w: null, prev_close: null, inactive: false, attributes: {}, category: null },
  ],
  holdings_order: ['h-aapl', 'h-msft', 'h-goog', 'h-2330', 'h-0050'],
  cash_accounts: [],
  debts: [],
  categories: [],
  plans: [],
  active_plan_id: null,
  snapshots: [],
  deletions: [],
  backups: [],
};

// T5 fixture: same five-holding fixture but every holding is inactive.
const ZERO_ACTIVE_FIXTURE = {
  ...FIVE_HOLDINGS_FIXTURE,
  settings: { ...FIVE_HOLDINGS_FIXTURE.settings },
  holdings: FIVE_HOLDINGS_FIXTURE.holdings.map((h) => ({ ...h, inactive: true })),
};

// Build a Yahoo-shaped success body for a given ticker/price.
function yahooSuccessBody(price, currency = 'USD') {
  return JSON.stringify({
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          currency,
          fiftyTwoWeekHigh: price * 1.1,
          fiftyTwoWeekLow: price * 0.9,
          chartPreviousClose: price * 0.99,
          gmtoffset: 0,
          currentTradingPeriod: { regular: { start: 0, end: 99999999999 } },
          instrumentType: 'EQUITY',
        },
      }],
    },
  });
}

// Yahoo failure: return 500 → lib/yahoo.js marks the ticker failed.
function yahooFailBody() {
  return 'server error';
}

// Runs in page context before any user script. We seed the proxy URL as a
// placeholder; if config.js is present, it overwrites with the real URL.
// Either way, readProxyHost() reads whichever URL is FINAL after page load.
const INIT_SCRIPT_HEADER = `
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(FIXTURE_DATA));
window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
window.PORTFOLIO_CONFIG.yahooProxyUrl = ${JSON.stringify(FALLBACK_PROXY_URL)};
`;

// Console errors that originate from 3rd-party scripts or the favicon are
// noise; we only care about app-level errors.
function isNoise(msg) {
  const text = msg.text();
  if (/tailwind|alpine\.js|googleapis\.com|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i.test(text)) return true;
  if (/Failed to load resource/i.test(text)) {
    if (/status of 500/i.test(text)) return true;   // mocked Worker failure in T2
    if (/favicon\.ico$/i.test(msg.location()?.url || '')) return true;
    if (/status of 40[0-9]/i.test(text) && (msg.location()?.url || '') === '') return true;
  }
  return false;
}

function collectAppErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (isNoise(msg)) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

// Install init script with the chosen fixture. Playwright's addInitScript
// runs in every new page before user scripts; this is the same pattern
// refresh.spec.js / holdings-currency.spec.js use.
function initScriptFor(fixture) {
  return INIT_SCRIPT_HEADER.replace('FIXTURE_DATA', JSON.stringify(fixture));
}

async function readProxyHost(page) {
  const url = await page.evaluate(() => window.PORTFOLIO_CONFIG?.yahooProxyUrl || '');
  return url ? new URL(url).host : FALLBACK_PROXY_HOST;
}

// The restore-toast element lives at this stable testid (portfolio.html:6294).
const TOAST = '[data-testid="restore-toast"]';

async function toastText(page) {
  const handle = await page.locator(TOAST);
  if (!(await handle.isVisible({ timeout: 200 }).catch(() => false))) return null;
  return (await handle.innerText()).trim();
}

test.describe('v1.15 refresh completion toast', () => {
  test('T1: all-success refresh → success toast with count', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(FIVE_HOLDINGS_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    // Yahoo returns success for every symbol.
    await page.route(`**/${proxyHost}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: yahooSuccessBody(100, 'USD'),
      });
    });

    // Navigate to Holdings so the refresh button (always in header) drives
    // a visible refresh; price update is visible there too.
    await page.locator('button:has-text("Holdings")').click();
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });

    await page.locator('.refresh-btn').click();

    // Toast appears with the success text and a count.
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    const text = (await toast.innerText()).trim();
    expect(text).toContain('Refreshed');
    expect(text).toContain('5');
    expect(text).toContain('holdings');

    // Toast clears within 6s (5s timeout + buffer).
    await expect(toast).toBeHidden({ timeout: 7_000 });

    expect(errors).toEqual([]);
  });

  test('T2: partial refresh → warning toast + amber Retry button + row badge', async ({ page }) => {
    test.setTimeout(60_000); // 5 attempts × up to 16s backoff each
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(FIVE_HOLDINGS_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    // First call (and subsequent ones for the failing symbols) returns 500.
    // Non-failing symbols get success on attempt 1.
    // Extract the symbol from the URL-encoded Yahoo chart path.
    // proxyUrl encodes the entire Yahoo URL as a query param value, so
    // `chart/AAPL?interval=...` becomes `chart%2FAAPL%3Finterval%3D...`.
    // The path separator ` / ` is encoded as `%2F` and the query `?` as
    // `%3F`, neither of which appear raw before the symbol.
    await page.route(`**/${proxyHost}/**`, async (route) => {
      const reqUrl = route.request().url();
      // Match `chart%2FSYMBOL%3F` (or `%2FSYMBOL%26` / end-of-string).
      const m = reqUrl.match(/chart%2F([^&?]+)/);
      const sym = m ? decodeURIComponent(m[1]).replace(/[?&].*$/, '') : '';
      if (sym === 'AAPL' || sym === 'MSFT') {
        await route.fulfill({ status: 500, body: yahooFailBody() });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: yahooSuccessBody(100, 'USD'),
        });
      }
    });

    await page.locator('button:has-text("Holdings")').click();
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });

    await page.locator('.refresh-btn').click();

    // After all 5 attempts exhaust for AAPL/MSFT, refreshState → 'partial'
    // and the amber "Retry N failed" button appears.
    await expect(page.locator('button:has-text("Retry 2 failed")')).toBeVisible({ timeout: 60_000 });
    // Row badge (red `tr.refresh-failed` class, portfolio.html:405).
    await expect(page.locator('tr.refresh-failed')).toHaveCount(2);

    // Warning toast appears with the partial text.
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    const text = (await toast.innerText()).trim();
    expect(text).toContain('Refreshed');
    expect(text).toMatch(/3.*5/); // succeeded=3, total=5
    expect(text).toContain('2');
    expect(text).toContain('failed');
    // Warning variant → amber background (bg-amber-500 in the toast scope).
    const cls = await toast.getAttribute('class');
    expect(cls).toContain('amber');

    expect(errors).toEqual([]);
  });

  test('T3: proxy not configured → rose banner, NO toast', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(FIVE_HOLDINGS_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');

    // config.js (loaded after addInitScript) seeds the proxy URL with the
    // real Worker. Override it to empty AFTER navigation so refreshButtonClick's
    // pre-flight short-circuits to refreshState='error' + rose banner
    // (portfolio.html:3870).
    await page.evaluate(() => {
      window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
      window.PORTFOLIO_CONFIG.yahooProxyUrl = '';
    });

    await page.locator('.refresh-btn').click();

    // Rose banner appears.
    await expect(page.locator('text=Yahoo proxy not configured')).toBeVisible({ timeout: 5_000 });

    // Toast must NOT appear.
    const toast = page.locator(TOAST);
    await page.waitForTimeout(800);
    expect(await toast.isVisible().catch(() => false)).toBe(false);

    expect(errors).toEqual([]);
  });

  test('T4: cancel mid-flight → silent, NO toast', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(FIVE_HOLDINGS_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    // Mock Yahoo to always return 500 — every refresh attempt will fail.
    // The retry loop has 5 attempts with backoff 1s, 2s, 4s, 8s, 16s.
    await page.route(`**/${proxyHost}/**`, async (route) => {
      await route.fulfill({ status: 500, body: yahooFailBody() });
    });

    await page.locator('.refresh-btn').click();

    // Wait until the refresh button label flips to "Refreshing..." so we
    // know we're mid-loop (attempt 1 already in flight).
    await expect(page.locator('.refresh-btn-text:text-is("Refreshing...")')).toBeVisible({ timeout: 5_000 });

    // Click again → cancel signal flips refreshCancelRequested; lib's head
    // cancel check at attempt 2+ breaks the loop.
    await page.locator('.refresh-btn').click();

    // After cancel, loop exits with res.cancelled=true. _applyRefreshResult
    // is called → refreshState goes back to idle (or partial if some symbols
    // already succeeded — here all failed, so it's a cancel-mid-failure case).
    // Either way, NO toast should appear.
    await expect(page.locator('.refresh-btn-text:text-is("Refreshing...")')).toBeHidden({ timeout: 30_000 });

    // Toast must NOT appear.
    await page.waitForTimeout(800);
    const toast = page.locator(TOAST);
    expect(await toast.isVisible().catch(() => false)).toBe(false);

    expect(errors).toEqual([]);
  });

  test('T5: 0 active holdings → silent, NO toast', async ({ page }) => {
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(ZERO_ACTIVE_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');

    // Track whether the proxy URL is hit at all.
    let hitCount = 0;
    await page.route(`**/${FALLBACK_PROXY_HOST}/**`, async (route) => {
      hitCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: yahooSuccessBody(100, 'USD') });
    });

    await page.locator('.refresh-btn').click();

    // Wait briefly — refreshAllPrices's early return for empty target should
    // be synchronous, so a toast would have fired by now if it were going to.
    await page.waitForTimeout(1500);
    const toast = page.locator(TOAST);
    expect(await toast.isVisible().catch(() => false)).toBe(false);

    // Defensive: the proxy should not have been called either (0 targets).
    expect(hitCount).toBe(0);

    expect(errors).toEqual([]);
  });

  test('T6: retry path → toast reports retry scope, not full portfolio', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectAppErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(initScriptFor(FIVE_HOLDINGS_FIXTURE));

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    // Track per-symbol call counts so we can switch behavior after the
    // user manually clicks "Retry 2 failed" (i.e. after the 5-attempt
    // exhaust). See the regex note in T2's route handler for the encoded
    // path separator.
    const callCounts = {};
    await page.route(`**/${proxyHost}/**`, async (route) => {
      const reqUrl = route.request().url();
      const m = reqUrl.match(/chart%2F([^&?]+)/);
      const sym = m ? decodeURIComponent(m[1]).replace(/[?&].*$/, '') : '';
      callCounts[sym] = (callCounts[sym] || 0) + 1;
      const n = callCounts[sym];

      // AAPL and MSFT fail for the first 5 calls (one per attempt of the
      // initial refresh) and succeed on the 6th+ call (after manual retry).
      if (sym === 'AAPL' || sym === 'MSFT') {
        if (n <= 5) {
          await route.fulfill({ status: 500, body: yahooFailBody() });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: yahooSuccessBody(150, 'USD'),
          });
        }
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: yahooSuccessBody(100, 'USD'),
        });
      }
    });

    await page.locator('button:has-text("Holdings")').click();
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });

    // 1) Initial refresh: AAPL/MSFT exhaust 5 attempts; 3 succeed; partial.
    await page.locator('.refresh-btn').click();
    await expect(page.locator('button:has-text("Retry 2 failed")')).toBeVisible({ timeout: 60_000 });

    // Wait for the initial toast to clear (5s + buffer) so it doesn't
    // pollute the retry toast assertion.
    await expect(page.locator(TOAST)).toBeHidden({ timeout: 7_000 });

    // 2) Click "Retry 2 failed" — refreshAllPrices(this.refreshFailures)
    //    runs with targetSet.size === 2 (just AAPL, MSFT).
    await page.locator('button:has-text("Retry 2 failed")').click();

    // The retry-path toast should report 2 / 2 (the retry scope), NOT 5
    // (the full portfolio).
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    const text = (await toast.innerText()).trim();
    expect(text).toContain('Refreshed');
    expect(text).toContain('2');
    // Must NOT mention 5 (the full-portfolio total).
    expect(text).not.toMatch(/\b5\b/);
    expect(text).toContain('holdings');

    expect(errors).toEqual([]);
  });
});
