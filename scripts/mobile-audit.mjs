#!/usr/bin/env node
// scripts/mobile-audit.mjs — v1.9 mobile audit (Playwright headless).
//
// Runs against `./dev.sh 8000` (start it in another shell first).
// Captures per-page overflow + small-button + table-count data, plus
// per-page full-page PNG screenshots, from a 414×736 (iPhone 6 Plus /
// Max baseline) viewport.
//
// Output: a Markdown audit report (default
// `.scratch/v1.9-mobile-responsiveness/audit-report.md`) with one table
// per page body + one per modal. Screenshots are written to
// `.scratch/v1.9-mobile-responsiveness/audit-screenshots/`.
//
// Usage:
//   ./dev.sh 8000 &
//   node scripts/mobile-audit.mjs                          # default output paths
//   node scripts/mobile-audit.mjs --output <file.md>      # override report path
//   node scripts/mobile-audit.mjs --screenshots <dir>     # override shot dir
//   AUDIT_BASE_URL=http://localhost:9000 node scripts/mobile-audit.mjs
//   AUDIT_CHROMIUM_PATH=/path/to/chrome node scripts/mobile-audit.mjs
//
// Exit code: 0 if dev server reachable + audit completed; 1 if dev
// server unreachable or any unexpected error.
//
// This script is an on-demand diagnostic tool — it does NOT run inside
// `scripts/safety-net.sh`. The mobile smoke test lives in
// `tests/browser/_mobile_smoke.spec.js` and runs in safety-net stage 4.

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------- Config ----------

const VIEWPORT = { width: 414, height: 736 };
const BASE_URL = process.env.AUDIT_BASE_URL ?? 'http://localhost:8000';
const DEFAULT_OUTPUT = '.scratch/v1.9-mobile-responsiveness/audit-report.md';
const DEFAULT_SHOTS  = '.scratch/v1.9-mobile-responsiveness/audit-screenshots';

const argv = process.argv.slice(2);
function getOpt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const OUTPUT    = getOpt('output',    DEFAULT_OUTPUT);
const SHOTS_DIR = getOpt('screenshots', DEFAULT_SHOTS);

// Touch-target thresholds (CSS pixels). Apple HIG = 44×44 pt; Material =
// 48×48 dp. We follow Apple's bar at 44 and report any smaller as
// findings; between 32 and 43 is "warning", below 32 is "blocker".
const TOUCH_BLOCKER = 32;
const TOUCH_WARN    = 44;

// Use the system chromium by default (matches playwright.config.ts
// `executablePath`). Override via AUDIT_CHROMIUM_PATH or
// PLAYWRIGHT_CHROMIUM_PATH; unset both and run `npx playwright install
// chromium` to use Playwright's bundled build (~150 MB download).
const SYSTEM_CHROMIUM = process.env.AUDIT_CHROMIUM_PATH
  ?? process.env.PLAYWRIGHT_CHROMIUM_PATH
  ?? '/usr/bin/chromium';
const CHROMIUM_LAUNCH_OPTS = existsSync(SYSTEM_CHROMIUM)
  ? { executablePath: SYSTEM_CHROMIUM }
  : {};

// ---------- Page inventory ----------

// 8 page bodies per the v1.9 map.
const PAGES = [
  { id: 'home',       label: 'Home' },
  { id: 'holdings',   label: 'Holdings' },
  { id: 'cash_debt',  label: 'Cash & Debts' },
  { id: 'categories', label: 'Categories' },
  { id: 'plans',      label: 'Plans' },
  { id: 'rebalance',  label: 'Rebalance' },
  { id: 'snapshots',  label: 'Snapshots' },
  { id: 'backups',    label: 'Backups' },
];

// 5 modals (5th = Intraday confirm; only triggered by intraday market-
// hours click — we don't simulate clocks so we cover it indirectly via
// the same wrapper and document the gap in the report).
const MODALS = [
  { id: 'holding',     label: 'Add Holding',     open: 'openAdd',         close: 'closeModal',     showFlag: 'showModal',     navTo: 'holdings' },
  { id: 'cash',        label: 'Add Cash',        open: 'openAddCash',     close: 'closeCashModal', showFlag: 'showCashModal', navTo: 'cash_debt' },
  { id: 'debt',        label: 'Add Debt',        open: 'openAddDebt',     close: 'closeDebtModal', showFlag: 'showDebtModal', navTo: 'cash_debt' },
  { id: 'sync',        label: 'Sync',            open: 'openSyncModal',   close: 'closeSyncModal', showFlag: 'showSyncModal', navTo: 'backups' },
];

// ---------- Fixture ----------

// One populated fixture so pages that need content actually render it.
// Empty-state-only pages (snapshots, backups) also receive the fixture;
// their empty states render even with content.
// Notes:
//   - current_price: hard-coded so refresh is irrelevant (no network).
//   - high_52w + low_52w: populated so the 52-week component renders.
//   - 5 holdings × 4 currencies (TWD/USD/JPY/EUR/CNY) exercises FX.
//   - 2 cash accounts + 1 debt, so all three Cash-Debts lists render.
//   - 2 categories with 3-5 values, so the Categories page renders.
//   - 1 plan with 1 rule target_weight_pct=50, so the Rebalance page
//     renders candidates; mirrors `tests/browser/rebalance.spec.js`.
const STORAGE_KEY = 'property_tracker_portfolio_v1';
const FIXTURE = {
  version: '1.1',
  holdings: [
    { id: 'h-aud-1', ticker: '2330.TW',    shares: 1000, cost: 50,    currency: 'TWD', current_price: 600,   prev_close: 590,   high_52w: 620,   low_52w: 540,   inactive: false, attributes: { 'cat-region': 'val-TW',    'cat-type': 'val-stock' }, day_delta: 10 },
    { id: 'h-aud-2', ticker: 'AAPL',       shares: 50,   cost: 150,   currency: 'USD', current_price: 200,   prev_close: 198,   high_52w: 220,   low_52w: 170,   inactive: false, attributes: { 'cat-region': 'val-US',    'cat-type': 'val-stock' }, day_delta: 2 },
    { id: 'h-aud-3', ticker: '7203.T',     shares: 100,  cost: 1800,  currency: 'JPY', current_price: 2500,  prev_close: 2400,  high_52w: 2800,  low_52w: 2200,  inactive: false, attributes: { 'cat-region': 'val-JP',    'cat-type': 'val-stock' }, day_delta: 100 },
    { id: 'h-aud-4', ticker: 'ASML.AS',    shares: 10,   cost: 600,   currency: 'EUR', current_price: 700,   prev_close: 690,   high_52w: 800,   low_52w: 500,   inactive: false, attributes: { 'cat-region': 'val-EU',    'cat-type': 'val-stock' }, day_delta: 10 },
    { id: 'h-aud-5', ticker: '0700.HK',    shares: 500,  cost: 200,   currency: 'CNY', current_price: 300,   prev_close: 295,   high_52w: 350,   low_52w: 250,   inactive: false, attributes: { 'cat-region': 'val-CN',    'cat-type': 'val-stock' }, day_delta: 5 },
  ],
  holdings_order: ['h-aud-1', 'h-aud-2', 'h-aud-3', 'h-aud-4', 'h-aud-5'],
  cash_accounts: [
    { id: 'c-aud-1', name: 'Checking',  currency: 'TWD', balance: 50000,  inactive: false, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-cash' } },
    { id: 'c-aud-2', name: 'Savings',   currency: 'USD', balance: 5000,   inactive: false, attributes: { 'cat-region': 'val-US', 'cat-type': 'val-cash' } },
  ],
  cash_accounts_order: ['c-aud-1', 'c-aud-2'],
  debts: [
    { id: 'd-aud-1', name: 'Credit Card', currency: 'TWD', balance: 30000, original_amount: 50000, apr: 18.5, min_payment: 1500, inactive: false, attributes: { 'cat-region': 'val-TW', 'cat-type': 'val-debt' } },
  ],
  debts_order: ['d-aud-1'],
  categories: [
    { id: 'cat-region', name: 'Region',    applies_to: ['holdings', 'cash', 'debt'], order: 0, values: [
      { id: 'val-TW', name: 'TW' },
      { id: 'val-US', name: 'US' },
      { id: 'val-JP', name: 'JP' },
      { id: 'val-EU', name: 'EU' },
      { id: 'val-CN', name: 'CN' },
    ] },
    { id: 'cat-type',   name: 'Type',      applies_to: ['holdings', 'cash', 'debt'], order: 1, values: [
      { id: 'val-stock', name: 'Stock' },
      { id: 'val-bond',  name: 'Bond' },
      { id: 'val-cash',  name: 'Cash' },
      { id: 'val-debt',  name: 'Debt' },
    ] },
  ],
  snapshots: [],
  plans: [
    {
      id: 'plan-aud-1',
      name: '60/40 plan',
      active: true,
      rules: [
        {
          id: 'rule-aud-1',
          name: 'Stocks',
          target_weight_pct: 50,
          when: [
            { category_id: 'cat-type', value_ids: ['val-stock'] },
          ],
          distribute: [
            { category_id: 'cat-region', value_ids: ['val-TW', 'val-US', 'val-JP', 'val-EU', 'val-CN'], weights: [40, 30, 10, 10, 10] },
          ],
        },
      ],
    },
  ],
  active_plan_id: 'plan-aud-1',
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
    device_id: 'audit-script-device',
    last_synced_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
  },
};

// ---------- Metric collection (in-page) ----------

// We pass this as a single string to `page.evaluate` because browser
// `eval` cannot see outer-scope references (it has no closure access).
const COLLECT_METRICS_FN = `((viewportW) => {
  const describeSelector = (el) => {
    if (el.dataset && el.dataset.testid) return '[data-testid="' + el.dataset.testid + '"]';
    if (el.id) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    const cls = (el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : '');
    return cls ? tag + '.' + cls : tag;
  };

  const docW = document.documentElement.scrollWidth;
  const overflow = docW > viewportW ? docW - viewportW : 0;

  const buttons = Array.from(document.querySelectorAll('button, a[href], input[type="button"], input[type="submit"]'))
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      // Skip elements inside a closed <details> (children only render
      // when the details is open). Walk up the ancestors to find one.
      let p = el.parentElement;
      while (p && p.tagName !== 'DETAILS') p = p.parentElement;
      if (p && !p.hasAttribute('open')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60);
      return {
        selector: describeSelector(el),
        text,
        width: Math.round(r.width),
        height: Math.round(r.height),
        x: Math.round(r.left),
        y: Math.round(r.top),
      };
    });

  const tables = Array.from(document.querySelectorAll('table'))
    .filter((t) => {
      const cs = getComputedStyle(t);
      if (cs.display === 'none') return false;
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((t) => {
      const headerCells = Array.from(t.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'));
      return {
        colCount: headerCells.length,
        width: Math.round(t.getBoundingClientRect().width),
      };
    });

  const detailsCount = document.querySelectorAll('details').length;
  const summaryCount = document.querySelectorAll('summary').length;

  const horizontalScrollContainers = Array.from(document.querySelectorAll('*'))
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => ({
      selector: describeSelector(el),
      width: Math.round(el.getBoundingClientRect().width),
    }));

  return { docW, overflow, buttons, tables, detailsCount, summaryCount, horizontalScrollContainers };
})`;

async function collectPageMetrics(page) {
  return await page.evaluate(`${COLLECT_METRICS_FN}(${VIEWPORT.width});`);
}

// ---------- Navigation + modal helpers (in-page) ----------

const NAVIGATE_FN = `((cp) => {
  const root = document.querySelector('[x-data]');
  if (root && window.Alpine) {
    try {
      const data = window.Alpine.$data(root);
      data.currentPage = cp;
      return true;
    } catch (e) { return false; }
  }
  return false;
})`;

const CALL_METHOD_FN = `((fn) => {
  const root = document.querySelector('[x-data]');
  if (root && window.Alpine) {
    try {
      const data = window.Alpine.$data(root);
      if (typeof data[fn] === 'function') {
        data[fn]();
        return true;
      }
      return false;
    } catch (e) { return false; }
  }
  return false;
})`;

async function alpineNavigate(page, currentPage) {
  await page.evaluate(`${NAVIGATE_FN}(${JSON.stringify(currentPage)});`);
  await page.waitForTimeout(180);
}

async function alpineCall(page, method) {
  await page.evaluate(`${CALL_METHOD_FN}(${JSON.stringify(method)});`);
  await page.waitForTimeout(220);
}

// ---------- Markdown rendering ----------

function severityRank(sev) {
  return sev === 'blocker' ? 0 : sev === 'warning' ? 1 : 2;
}

function buttonSeverity(b) {
  if (b.width < TOUCH_BLOCKER || b.height < TOUCH_BLOCKER) return 'blocker';
  if (b.width < TOUCH_WARN    || b.height < TOUCH_WARN)    return 'warning';
  return null;
}

// Categorize a button for the hot list. Categorization is done by
// selector pattern + data-testid prefix; cheap heuristic but useful.
function categorizeButton(sel, text) {
  if (/data-testid="holdings-move-/.test(sel))           return 'inline-table-button';
  if (/data-testid="cash-move-/.test(sel))               return 'inline-table-button';
  if (/data-testid="debts-move-/.test(sel))              return 'inline-table-button';
  if (/data-testid="(holdings|cash|debts)-(edit|delete|toggle|active)/.test(sel)) return 'inline-table-button';
  if (/button\.px-3\.py-1\.rounded/.test(sel))           return 'language-or-currency-toggle';
  if (/button\.refresh-btn/.test(sel))                   return 'header-refresh';
  if (/button\.text-sm\.px-3\.py-1\.5/.test(sel))        return 'header-status-badge';
  if (/button\.text-sm\.text-slate-600\.hover/.test(sel))return 'header-menu-item';
  if (/text-slate-400\.hover:text-slate-900\.px-1/.test(sel)) return 'inline-table-button';
  if (/text-slate-400\.hover:text-rose-600\.px-1/.test(sel))  return 'inline-table-button';
  if (/px-1\.text-xs\.hover:underline/.test(sel))       return 'inline-table-button';
  if (/data-testid="plan-/.test(sel))                    return 'plan-action';
  if (/data-testid="snapshot-/.test(sel))                return 'snapshot-action';
  if (/data-testid="rebalance-/.test(sel))               return 'rebalance-action';
  if (/button\.bg-slate-900\.text-white\.text-sm/.test(sel)) return 'page-cta';
  if (/button\.px-4\.py-2/.test(sel))                    return 'modal-action';
  if (/button\.text-sm\.bg-slate-900\.text-white/.test(sel)) return 'page-cta-secondary';
  return 'other';
}

function renderPageSection(label, m, screenshotRelPath) {
  const lines = [];
  lines.push(`### ${label}\n`);
  lines.push(`**Screenshot**: \`${screenshotRelPath}\``);
  lines.push(`**Document scrollWidth**: ${m.docW}px (overflow: ${m.overflow}px)\n`);

  const flagged = m.buttons
    .map((b) => ({ b, sev: buttonSeverity(b) }))
    .filter((x) => x.sev)
    .sort((a, z) => severityRank(a.sev) - severityRank(z.sev));

  if (flagged.length === 0) {
    lines.push('**Touch targets**: all measured buttons ≥44×44px ✅\n');
  } else {
    lines.push(`**Touch targets**: ${flagged.length} buttons below threshold\n`);

    // Group by category for the hot list.
    const byCat = new Map();
    for (const { b, sev } of flagged) {
      const cat = categorizeButton(b.selector, b.text);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ ...b, sev });
    }
    lines.push('**By category:**\n');
    lines.push('| Category | Count | Sample selector | Sample size |');
    lines.push('|---|---|---|---|');
    for (const [cat, list] of [...byCat.entries()].sort((a, z) => z[1].length - a[1].length)) {
      const sample = list[0];
      const safe = (s) => s.replace(/\|/g, '\\|');
      lines.push(`| \`${cat}\` | ${list.length} | \`${safe(sample.selector)}\` | ${sample.width}×${sample.height} |`);
    }
    lines.push('');
  }

  if (m.tables.length > 0) {
    lines.push(`**Tables**: ${m.tables.length} (col counts: ${m.tables.map((t) => t.colCount).join(', ')})\n`);
    const wide = m.tables.filter((t) => t.colCount >= 5);
    if (wide.length > 0) {
      lines.push(`> ⚠️ Tables with ≥5 columns are likely to overflow at 414px and need stacked-card treatment.\n`);
    }
  } else {
    lines.push('**Tables**: none on this page ✅\n');
  }

  if (m.detailsCount > 0) {
    lines.push(`**Expandable content**: ${m.detailsCount} \`<details>\` blocks (${m.summaryCount} \`<summary>\` triggers)\n`);
  }

  if (m.horizontalScrollContainers.length > 0) {
    lines.push(`**Intentional horizontal scroll containers** (overflow-x-auto):\n`);
    for (const c of m.horizontalScrollContainers) {
      lines.push(`- \`${c.selector}\` (${c.width}px wide)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderModalSection(label, openMethod, m, screenshotRelPath) {
  const lines = [];
  lines.push(`### ${label}\n`);
  lines.push(`**Trigger**: \`${openMethod}()\``);
  lines.push(`**Screenshot**: \`${screenshotRelPath}\``);
  lines.push(`**Modal scrollWidth**: ${m.docW}px (overflow: ${m.overflow}px)\n`);

  const flagged = m.buttons
    .map((b) => ({ b, sev: buttonSeverity(b) }))
    .filter((x) => x.sev)
    .sort((a, z) => severityRank(a.sev) - severityRank(z.sev));

  if (flagged.length === 0) {
    lines.push('**Touch targets**: all measured buttons ≥44×44px ✅\n');
  } else {
    lines.push(`**Touch targets**: ${flagged.length} buttons below threshold\n`);

    const byCat = new Map();
    for (const { b, sev } of flagged) {
      const cat = categorizeButton(b.selector, b.text);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ ...b, sev });
    }
    lines.push('**By category:**\n');
    lines.push('| Category | Count | Sample selector | Sample size |');
    lines.push('|---|---|---|---|');
    for (const [cat, list] of [...byCat.entries()].sort((a, z) => z[1].length - a[1].length)) {
      const sample = list[0];
      const safe = (s) => s.replace(/\|/g, '\\|');
      lines.push(`| \`${cat}\` | ${list.length} | \`${safe(sample.selector)}\` | ${sample.width}×${sample.height} |`);
    }
    lines.push('');
  }

  if (m.tables.length > 0) {
    lines.push(`**Tables inside modal**: ${m.tables.length}\n`);
  }

  return lines.join('\n');
}

// ---------- Main ----------

async function main() {
  console.error(`[audit] Connecting to ${BASE_URL} ...`);

  // Sanity-check the dev server is reachable.
  let res;
  try {
    res = await fetch(BASE_URL + '/portfolio.html');
    if (!res.ok) {
      console.error(`[audit] Dev server returned HTTP ${res.status}; aborting.`);
      console.error(`[audit] Start it first:  ./dev.sh 8000`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[audit] Could not reach ${BASE_URL}: ${e.message}`);
    console.error(`[audit] Start the dev server first:  ./dev.sh 8000`);
    process.exit(1);
  }

  await mkdir(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true, ...CHROMIUM_LAUNCH_OPTS });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,        // hi-DPI screenshot, helps manual review.
  });

  // Inject the populated fixture BEFORE any page script runs.
  // NOTE on the JSON-double-encode trick: a single JSON.stringify on
  // an object returns JSON text without surrounding quotes; injecting
  // that directly into a JS source makes the runtime treat it as an
  // object literal and `.toString()` it into "[object Object]".
  // JSON.stringify(text) produces a properly quoted JS string literal,
  // which is what we need.
  const FIXTURE_LITERAL = JSON.stringify(JSON.stringify(FIXTURE));
  const FIXTURE_KEY_LITERAL = JSON.stringify(STORAGE_KEY);
  await context.addInitScript(`
    try { localStorage.setItem(${FIXTURE_KEY_LITERAL}, ${FIXTURE_LITERAL}); } catch (e) { console.error('audit fixture injection failed:', e); }
  `);

  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[audit] pageerror: ${e.message}`));

  // First nav: load the app so Alpine initializes against our fixture.
  await page.goto(`${BASE_URL}/portfolio.html`);
  await page.waitForFunction(() => !!window.Alpine, { timeout: 10_000 });
  await page.waitForTimeout(500);

  const out = [];
  out.push('# v1.9 Mobile Audit — Raw Data');
  out.push('');
  out.push(`_Generated: ${new Date().toISOString()}_  `);
  out.push(`_Viewport: ${VIEWPORT.width}×${VIEWPORT.height} px (iPhone 6 Plus / Max baseline)_  `);
  out.push(`_Base URL: ${BASE_URL}_  `);
  out.push(`_Fixture: 5 holdings × 4 currencies + 2 cash + 1 debt + 2 categories + 1 plan with target_weight_pct=50_`);
  out.push('');
  out.push('---');
  out.push('');

  // ----- Page body audit -----
  out.push('## Page bodies (8)\n');
  for (const p of PAGES) {
    console.error(`[audit] Auditing page: ${p.id} ...`);
    await alpineNavigate(page, p.id);
    const shotPath = path.join(SHOTS_DIR, `${p.id}-414.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    const m = await collectPageMetrics(page);
    out.push(renderPageSection(`${p.label} (currentPage='${p.id}')`, m, path.relative(path.dirname(OUTPUT), shotPath)));
    out.push('');
  }

  // ----- Modal audit -----
  out.push('## Modals (4 measured + 1 documented)\n');
  for (const modal of MODALS) {
    console.error(`[audit] Auditing modal: ${modal.id} ...`);
    await alpineNavigate(page, modal.navTo);
    await alpineCall(page, modal.open);

    const shotPath = path.join(SHOTS_DIR, `modal-${modal.id}-414.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    const m = await collectPageMetrics(page);
    out.push(renderModalSection(`${modal.label} modal`, modal.open, m, path.relative(path.dirname(OUTPUT), shotPath)));
    out.push('');

    await alpineCall(page, modal.close);
    await page.waitForTimeout(180);
  }

  // 5th modal: Intraday confirm. Document why not measured here.
  out.push(`### Intraday confirm modal\n`);
  out.push(`**Not measured directly**: triggered by \`shouldWarnIntraday()\` heuristic (time-of-day + market `);
  out.push(`open). The audit does not simulate clocks.`);
  out.push(`Same \`w-full max-w-md p-6 max-h-[90vh] overflow-y-auto\` wrapper as the other 4 modals, so findings `);
  out.push(`transfer. Visual review of the screenshot will confirm at the user's leisure.\n`);

  // ----- Header / nav audit -----
  out.push('## Header / nav\n');
  await alpineNavigate(page, 'home');
  const headerShot = path.join(SHOTS_DIR, 'header-414.png');
  await page.screenshot({ path: headerShot, fullPage: false });
  const headerMetrics = await page.evaluate(`(() => {
    const header = document.querySelector('header') || document.querySelector('nav');
    if (!header) return null;
    const r = header.getBoundingClientRect();
    const overflow = r.right > ${VIEWPORT.width} ? Math.round(r.right - ${VIEWPORT.width}) : 0;
    return { width: Math.round(r.width), right: Math.round(r.right), overflow };
  })()`);
  if (headerMetrics) {
    out.push(`**Header element**: \`header\` / \`nav\` block on current page`);
    out.push(`**Header width**: ${headerMetrics.width}px (right edge: ${headerMetrics.right}px, overflow: ${headerMetrics.overflow}px)`);
  } else {
    out.push('**Header element**: not found');
  }
  out.push(`**Screenshot**: \`${path.relative(path.dirname(OUTPUT), headerShot)}\`\n`);
  out.push('See per-page findings above for the per-button touch-target analysis on this region.\n');

  out.push('---');
  out.push('');

  await browser.close();
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, out.join('\n'), 'utf-8');
  console.error(`[audit] Report written to ${OUTPUT}`);
  console.error(`[audit] Screenshots in      ${SHOTS_DIR}`);
}

main().catch((e) => {
  console.error('[audit] Unexpected error:', e);
  process.exit(1);
});
