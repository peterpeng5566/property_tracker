// playwright.config.ts — browser smoke configuration.
//
// Run: stage 4 of ./scripts/safety-net.sh (NOT ./test.sh — Playwright owns
// its own test discovery under testDir).
//
// Single-project Chromium-only per ticket 03 / spec §Browser smoke.
//
// webServer spawns ./dev.sh 8000 with reuseExistingServer: true. If the dev
// server is already up (e.g. agent is iterating with the browser open), we
// attach to it; otherwise the agent's own server is used.
//
// executablePath: prefers the system Chromium binary at /usr/bin/chromium
// (faster, no ~150 MB download). Override via PLAYWRIGHT_CHROMIUM_PATH if
// the binary lives elsewhere, or unset it and run `npx playwright install
// chromium` to use Playwright's bundled build.

import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const SYSTEM_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,   // Single browser instance; tests share port 8000.
  retries: 0,             // Smoke must be deterministic; no flake retry.
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:8000',
    headless: true,
    launchOptions: existsSync(SYSTEM_CHROMIUM)
      ? { executablePath: SYSTEM_CHROMIUM }
      : {},
  },
  webServer: {
    command: './dev.sh 8000',
    port: 8000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
