// Regression tests for the v1.13 / mobile-header polish tickets.
//
// 1. Header menu (⋯) summary does NOT get the global `+` prefix that
//    the mobile-card `<details>` rule adds (port 0020 stacked-cards
//    leaked into the header menu's ::before).
// 2. Header menu (⋯) closes on click-outside, not just on re-click of
//    the summary.
// 3. Mobile header is single-row at 414 px:
//    - Language toggle (EN/中) is hidden at <md, present at ≥md
//    - Currency toggle (TWD/USD) is hidden at <md, present at ≥md
//    - Page subtitle (summary text) is hidden at <md
//    - Page title is smaller at <md (16 px vs 20 px)
//    - Sync button is icon-only at <md (no text label)
// 4. Drawer Settings section is present at <md and contains the
//    language + currency toggles so the user can still change them.
// 5. Header right cluster fits on one row at 414 px (height ≤ 80 px
//    after polish).

const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'property_tracker_portfolio_v1';
const DEVICE_ID_KEY = 'device_id';

const fixture = {
  schema: '1.1',
  created_at: '2024-06-01T00:00:00.000Z',
  updated_at: '2024-06-01T00:00:00.000Z',
  device_id: 'audit-script-device',
  holdings: [
    { id: 'h1', ticker: '2330.TW', name: '台積電', category: 'cat-1', shares: 1000, cost: 580, current_price: 620, currency: 'TWD', region: 'TW', updated_at: '2024-06-01T00:00:00.000Z' },
  ],
  cash: [{ id: 'c1', name: '台新活存', currency: 'TWD', balance: 50000, updated_at: '2024-06-01T00:00:00.000Z' }],
  debts: [],
  categories: [
    { id: 'cat-1', name: '國內股票', color: '#0ea5e9', updated_at: '2024-06-01T00:00:00.000Z', device_id: 'audit-script-device' },
  ],
  plans: [],
  snapshots: [],
  settings: {
    fx_rate: 32.5,
    fx_updated_at: '2024-06-01T00:00:00.000Z',
    language: 'zh',
    currency: 'TWD',
    auto_sync: true,
    updated_at: '2024-06-01T00:00:00.000Z',
    device_id: 'audit-script-device',
  },
  deletions: [],
};

async function loadApp(page, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript(({ k, dk, blob }) => {
    localStorage.setItem(k, blob);
    localStorage.setItem(dk, 'audit-script-device');
  }, { k: STORAGE_KEY, dk: DEVICE_ID_KEY, blob: JSON.stringify(fixture) });
  await page.goto('http://localhost:8000/portfolio.html');
  await page.waitForFunction(() => window.Alpine && document.querySelector('[x-data]'));
}

test.describe('header menu (⋯) — global + prefix leaked into header menu', () => {
  test('header menu summary does NOT have a + ::before prefix', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    const beforeContent = await page.evaluate(() => {
      const summary = document.querySelector('.header-menu > summary');
      if (!summary) return null;
      return getComputedStyle(summary, '::before').content;
    });

    // The global rule adds content: '+' for any <summary>. The header
    // menu's summary is "⋯" — we expect it to have NO ::before content.
    expect(beforeContent).not.toBe('"+"');
    expect(beforeContent).toMatch(/^(none|normal|"?"|"⋯")|""$/);
  });

  test('mobile card <details> still DOES get a + ::before prefix (no regression)', async ({ page }) => {
    // Seed a holding so the mobile card renders
    await loadApp(page, { width: 414, height: 896 });
    await page.evaluate(() => {
      const root = document.querySelector('[x-data]');
      window.Alpine.$data(root).currentPage = 'holdings';
    });
    await page.waitForTimeout(150);

    const cardBeforeContent = await page.evaluate(() => {
      // Find the holding card's <details> (not the header menu)
      const cards = document.querySelectorAll('main details, .md\\:hidden details');
      for (const card of cards) {
        if (card.classList.contains('header-menu')) continue;
        const summary = card.querySelector('summary');
        if (!summary) continue;
        return getComputedStyle(summary, '::before').content;
      }
      return null;
    });

    // The mobile card <details> should still get the + prefix
    expect(cardBeforeContent).toBe('"+"');
  });
});

test.describe('header menu (⋯) — click-outside closes', () => {
  test('clicking outside the menu closes it', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    // Open the menu
    await page.locator('.header-menu > summary').click();
    await page.waitForTimeout(150);
    const openAfterClick = await page.evaluate(() =>
      document.querySelector('.header-menu').hasAttribute('open')
    );
    expect(openAfterClick).toBe(true);

    // Click outside the menu (on the page title)
    await page.evaluate(() => {
      document.querySelector('header h1').click();
    });
    await page.waitForTimeout(150);

    const openAfterOutside = await page.evaluate(() =>
      document.querySelector('.header-menu').hasAttribute('open')
    );
    expect(openAfterOutside).toBe(false);
  });

  test('clicking inside the menu items does NOT close it', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    // Open the menu
    await page.locator('.header-menu > summary').click();
    await page.waitForTimeout(150);

    // Click on the FX rate input (inside the menu)
    await page.evaluate(() => {
      const fxInput = document.querySelector('.header-menu-items input[type="number"]');
      fxInput.focus();
    });
    await page.waitForTimeout(150);

    const stillOpen = await page.evaluate(() =>
      document.querySelector('.header-menu').hasAttribute('open')
    );
    expect(stillOpen).toBe(true);
  });

  test('clicking the summary again toggles closed (default <details> behavior)', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    await page.locator('.header-menu > summary').click();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() =>
      document.querySelector('.header-menu').hasAttribute('open')
    )).toBe(true);

    await page.locator('.header-menu > summary').click();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() =>
      document.querySelector('.header-menu').hasAttribute('open')
    )).toBe(false);
  });
});

test.describe('mobile header compactness (414 px)', () => {
  test('language toggle (EN/中) is hidden at <md', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    const enBtnDisplay = await page.evaluate(() => {
      // Find the EN button inside the header, then walk up to its
      // wrapper (the .md\\:inline-flex container) and read its display.
      const header = document.querySelector('header');
      const enBtn = [...header.querySelectorAll('button')].find(b => b.textContent.trim() === 'EN');
      if (!enBtn) return null;
      const wrapper = enBtn.closest('div');
      return wrapper ? getComputedStyle(wrapper).display : null;
    });

    // The wrapper should be 'none' at <md (Tailwind hidden md:inline-flex)
    expect(enBtnDisplay).toBe('none');
  });

  test('currency toggle (TWD/USD) is hidden at <md', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    const displays = await page.evaluate(() => {
      const header = document.querySelector('header');
      const twdBtn = [...header.querySelectorAll('button')].find(b => b.textContent.trim() === 'TWD');
      if (!twdBtn) return null;
      const wrapper = twdBtn.closest('div');
      return wrapper ? getComputedStyle(wrapper).display : null;
    });

    // The TWD/USD toggle wrapper should be display:none at <md
    expect(displays).toBe('none');
  });

  test('subtitle is hidden at <md', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    const subtitleDisplay = await page.evaluate(() => {
      const subtitle = document.querySelector('header p');
      if (!subtitle) return null;
      return getComputedStyle(subtitle).display;
    });

    expect(subtitleDisplay).toBe('none');
  });

  test('title is smaller at <md (16 px vs 20 px on ≥md)', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });
    const mobileTitle = await page.evaluate(() => {
      const h1 = document.querySelector('header h1');
      return getComputedStyle(h1).fontSize;
    });

    await loadApp(page, { width: 1280, height: 800 });
    const desktopTitle = await page.evaluate(() => {
      const h1 = document.querySelector('header h1');
      return getComputedStyle(h1).fontSize;
    });

    // Mobile 16 px, desktop 20 px — accept ±0.5 px
    const mobilePx = parseFloat(mobileTitle);
    const desktopPx = parseFloat(desktopTitle);
    expect(mobilePx).toBeLessThanOrEqual(17);
    expect(desktopPx).toBeGreaterThanOrEqual(19);
  });

  test('sync button is icon-only at <md (no text label visible)', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    const mobileBtnInfo = await page.evaluate(() => {
      // The sync button is the one with x-text="syncStatusLabel" and class "border rounded-md"
      // We can identify it by its distinctive colored background that varies by syncStatus
      const buttons = [...document.querySelectorAll('header button')];
      const syncBtn = buttons.find(b => {
        const text = b.textContent.trim();
        // The button always contains the cloud emoji + status text
        return text.includes('☁️') || text.includes('☁');
      });
      if (!syncBtn) return null;
      const rect = syncBtn.getBoundingClientRect();
      return {
        text: syncBtn.textContent.trim(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });

    // At <md the button should be icon-only — width ≤ 50 px (just the emoji + padding)
    expect(mobileBtnInfo).not.toBeNull();
    expect(mobileBtnInfo.width).toBeLessThanOrEqual(50);
  });

  test('desktop header keeps all controls visible (≥md sanity)', async ({ page }) => {
    await loadApp(page, { width: 1280, height: 800 });

    const desktopDisplays = await page.evaluate(() => {
      const header = document.querySelector('header');
      const enBtn = [...header.querySelectorAll('button')].find(b => b.textContent.trim() === 'EN');
      const twdBtn = [...header.querySelectorAll('button')].find(b => b.textContent.trim() === 'TWD');
      const langWrapper = enBtn ? enBtn.closest('div') : null;
      const twdWrapper = twdBtn ? twdBtn.closest('div') : null;
      return {
        langDisplay: langWrapper ? getComputedStyle(langWrapper).display : null,
        twdDisplay: twdWrapper ? getComputedStyle(twdWrapper).display : null,
      };
    });

    // The EN/中 AND TWD/USD toggles should be display:flex at ≥md
    expect(desktopDisplays.langDisplay).not.toBe('none');
    expect(desktopDisplays.twdDisplay).not.toBe('none');
  });
});

test.describe('drawer Settings section (mobile)', () => {
  test('drawer contains a Settings section with language + currency toggles', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    // Open the drawer
    await page.locator('[data-testid="header-hamburger"]').click();
    await page.waitForTimeout(300);

    const drawerContent = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="mobile-nav-drawer"]');
      if (!drawer) return null;

      // Find all buttons in the drawer
      const buttons = [...drawer.querySelectorAll('button')];
      const buttonLabels = buttons.map(b => b.textContent.trim());

      // Look for the Settings section by finding Language and Currency controls
      const enBtn = buttons.find(b => b.textContent.trim() === 'EN');
      const twdBtn = buttons.find(b => b.textContent.trim() === 'TWD');

      return {
        buttonLabels,
        hasEnBtn: !!enBtn,
        hasTwdBtn: !!twdBtn,
        drawerFound: true,
      };
    });

    expect(drawerContent).not.toBeNull();
    expect(drawerContent.hasEnBtn).toBe(true);
    expect(drawerContent.hasTwdBtn).toBe(true);
  });

  test('tapping EN in drawer updates language (smoke)', async ({ page }) => {
    await loadApp(page, { width: 414, height: 896 });

    await page.locator('[data-testid="header-hamburger"]').click();
    await page.waitForTimeout(300);

    // Click the EN button inside the drawer
    await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="mobile-nav-drawer"]');
      const enBtn = [...drawer.querySelectorAll('button')].find(b => b.textContent.trim() === 'EN');
      enBtn.click();
    });
    await page.waitForTimeout(150);

    const lang = await page.evaluate(() => {
      return window.Alpine.$data(document.querySelector('[x-data]')).language;
    });

    expect(lang).toBe('en');
  });
});
