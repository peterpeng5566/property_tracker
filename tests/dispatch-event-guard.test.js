// tests/dispatch-event-guard.test.js — v1.10 follow-up A
//
// Regression guard for the v1.9.1 hamburger hotfix lesson (ba757da):
//
//   Tests that use `dispatchEvent(new MouseEvent('click', ...))` as a
//   click workaround mask production race conditions, because the
//   synthetic click propagates synchronously before Alpine's reactive
//   update mounts the just-clicked element. Real `locator.click()`
//   propagates asynchronously and is what users actually do.
//
// Codifies the rule as a unit test (node:test, no browser) by scanning
// every test in tests/browser/ for the forbidden patterns. If any test
// in that directory re-introduces the anti-pattern, this test fails in
// stage 1 of the safety net.
//
// NB: This file mentions the forbidden tokens inside string literals /
// comments. The scanner reads tests/browser/ files only — not itself —
// so the mention here is safe.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_TESTS_DIR = path.join(__dirname, 'browser');

// Forbidden patterns. The scanner reads files in tests/browser/ only,
// never itself, so mentioning the forbidden tokens here is safe and
// keeping them as plain string literals is the most readable form.
const FORBIDDEN_PATTERNS = [
  {
    name: 'dispatchEvent( — synthetic click workaround',
    needle: 'dispatchEvent(',
  },
  {
    name: 'new MouseEvent( — synthetic click event constructor',
    needle: 'new MouseEvent(',
  },
];

function listSpecFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.spec.js')) continue;
    out.push(path.join(dir, entry.name));
  }
  return out.sort();
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const hits = [];
  for (const { name, needle } of FORBIDDEN_PATTERNS) {
    const idx = text.indexOf(needle);
    if (idx !== -1) {
      hits.push({ name, line: text.slice(0, idx).split('\n').length });
    }
  }
  return hits;
}

test('no Playwright browser spec uses synthetic-click anti-patterns (v1.9.1 regression guard)', () => {
  const specs = listSpecFiles(BROWSER_TESTS_DIR);
  assert.ok(specs.length > 0, 'expected at least one test in tests/browser/');

  const offenders = [];
  for (const spec of specs) {
    const hits = scan(spec);
    if (hits.length > 0) {
      offenders.push({ file: path.basename(spec), hits });
    }
  }

  if (offenders.length > 0) {
    const lines = offenders.map(({ file, hits }) => {
      const hitDescr = hits.map(h => `${h.name} @ line ${h.line}`).join(', ');
      return `  ${file}: ${hitDescr}`;
    });
    assert.fail(
      [
        'Forbidden synthetic-click patterns found in tests/browser/:',
        ...lines,
        '',
        'These patterns mask production race conditions (see v1.9.1 hotfix ba757da).',
        'Replace with real `locator.click()` / `page.mouse.click()` and re-run.',
      ].join('\n'),
    );
  }
});