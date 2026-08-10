// tests/browser/refresh.spec.js — Playwright browser smoke for portfolio.html.
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright owns
// its own test discovery under playwright.config.ts testDir).
//
// What it covers (ticket 03 / spec §Browser smoke):
//   - portfolio.html loads end-to-end against ./dev.sh (CORS, scripts, Alpine).
//   - Refresh button drives the full Yahoo refresh workflow (proxy URL
//     construction, fetchQuotes, retry loop) without throwing.
//   - Worker URL boundary is mocked at `page.route` (NOT at
//     query1.finance.yahoo.com — lib/yahoo.js URL construction + browser
//     fetch default must be exercised).
//   - Failed-row UI appears when the Worker returns 500 (retry loop
//     exhausts after 5 attempts, refreshState → 'partial', retry button
//     shows).
//
// Wiring notes:
//   - The portfolio fixture is injected via page.addInitScript() into
//     localStorage under the key 'property_tracker_portfolio_v1'
//     (see portfolio.html:1176, `const STORAGE_KEY = ...`).
//   - The Worker URL is read from `window.PORTFOLIO_CONFIG.yahooProxyUrl`
//     after navigation. addInitScript seeds a placeholder; if a real
//     config.js is present, it overwrites with the real URL. Either way
//     we route at whatever host ends up active.

'use strict';

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';
const FALLBACK_PROXY_URL = 'https://yahoo-proxy.smoke-test.example.workers.dev/';
const FALLBACK_PROXY_HOST = 'yahoo-proxy.smoke-test.example.workers.dev';

// One TWD holding so the displayed price is `$225.50` after refresh (no FX
// conversion needed — keeps the assertion trivial).
const PORTFOLIO_FIXTURE = {
  version: '1.1',
  holdings: [
    {
      id: 'h-smoke-1',
      ticker: 'AAPL',
      shares: 10,
      cost: 100,
      currency: 'TWD',
      current_price: 0,
      high_52w: null,
      low_52w: null,
      prev_close: null,
      inactive: false,
      attributes: {},
    },
  ],
  cash_accounts: [],
  debts: [],
  categories: [],
  snapshots: [],
  settings: {
    display_currency: 'TWD',
    language: 'en',
    cost_format: 'per_share',
    fx_source: 'manual',
    fx_rate: 32.2,
  },
  meta: {
    device_id: 'smoke-test-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

// Runs in page context before any user script. Seeds PORTFOLIO_CONFIG (so
// portfolio.html refresh logic has a URL even if config.js is missing) and
// writes the fixture into localStorage. config.js may overwrite
// PORTFOLIO_CONFIG later — that is fine, we read whichever URL is final.
const INIT_SCRIPT = `
window.PORTFOLIO_CONFIG = window.PORTFOLIO_CONFIG || {};
window.PORTFOLIO_CONFIG.yahooProxyUrl = ${JSON.stringify(FALLBACK_PROXY_URL)};
localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(${JSON.stringify(PORTFOLIO_FIXTURE)}));
`;

const MOCK_YAHOO_BODY = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 225.50,
          currency: 'TWD',
          fiftyTwoWeekHigh: 250,
          fiftyTwoWeekLow: 200,
          chartPreviousClose: 220,
          gmtoffset: 0,
          currentTradingPeriod: { regular: { start: 0, end: 99999999999 } },
          instrumentType: 'EQUITY',
        },
      },
    ],
  },
});

// Console-error messages that originate from CDN/3rd-party scripts or from
// resources we don't ship (favicon). Filtered by checking the message text
// and (for resource-load failures) the URL in msg.location().
// The error-path test deliberately mocks the Worker to return 500, which
// surfaces as 'Failed to load resource: 500'; that is the test scenario, not
// an app-level bug, so we ignore it too.
function isNoise(msg) {
  const text = msg.text();
  if (CDN_NOISE.test(text)) return true;
  if (/Failed to load resource/i.test(text)) {
    const url = msg.location()?.url || '';
    if (/status of 500/i.test(text)) return true;   // mocked Worker failure
    if (/favicon\.ico$/i.test(url)) return true;    // python http.server has no favicon
  }
  return false;
}
const CDN_NOISE = /tailwind|alpine\.js|googleapis\.com|gsi\/client|fonts\.(googleapis|gstatic)|accounts\.google|cdn\.jsdelivr/i;

test.describe('portfolio.html refresh workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(INIT_SCRIPT);
  });

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

  async function readProxyHost(page) {
    const url = await page.evaluate(
      () => window.PORTFOLIO_CONFIG?.yahooProxyUrl || ''
    );
    const host = url ? new URL(url).host : FALLBACK_PROXY_HOST;
    return host;
  }

  test('happy path: refresh updates holding price in DOM', async ({ page }) => {
    const errors = collectAppErrors(page);

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    // Intercept at the Worker URL boundary — NOT query1.finance.yahoo.com.
    // This exercises lib/yahoo.js URL construction + browser fetch default.
    await page.route(`**/${proxyHost}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: MOCK_YAHOO_BODY,
      });
    });

    // Navigate to Holdings tab so the table is visible (default page is Home).
    await page.locator('button:has-text("Holdings")').click();

    // Holding row renders before we click (cost = $100.00, price = $0.00).
    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });

    await page.locator('.refresh-btn').click();

    // After refresh, h.current_price = 225.50 → "$225.50" appears.
    await expect(page.locator('td:text-is("$225.50")')).toBeVisible({ timeout: 10_000 });

    expect(errors).toEqual([]);
  });

  test('error path: 500 from Worker shows red badge + Retry button', async ({ page }) => {
    test.setTimeout(60_000); // 5 attempts × up to 16 s backoff each.

    const errors = collectAppErrors(page);

    await page.goto('http://localhost:8000/portfolio.html');
    const proxyHost = await readProxyHost(page);

    await page.route(`**/${proxyHost}/**`, async (route) => {
      await route.fulfill({ status: 500, body: 'server error' });
    });

    // Navigate to Holdings tab so the table is visible (default page is Home).
    await page.locator('button:has-text("Holdings")').click();

    await expect(page.locator('tr:has-text("AAPL")')).toBeVisible({ timeout: 10_000 });

    await page.locator('.refresh-btn').click();

    // After all 5 retry attempts fail, refreshState → 'partial', refreshFailures
    // contains the ticker, and the "Retry 1 failed" button appears.
    await expect(page.locator('button:has-text("Retry 1 failed")')).toBeVisible({
      timeout: 60_000,
    });

    // Red badge on the failed row (tr.refresh-failed, portfolio.html:405).
    await expect(page.locator('tr.refresh-failed')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
