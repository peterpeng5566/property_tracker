// tests/browser/_helpers.js — shared test-infra helpers for browser specs.
//
// Kept tiny and dependency-free. Anything added here should be a
// concern that 2+ specs need identically; one-off helpers belong
// inside the spec file.

'use strict';

/**
 * Unroute every `page.route` handler registered on the page.
 *
 * Used by tests that mock Drive via a wildcard route (e.g.
 * `page.route('**' + '/*', ...)` written to avoid the JS-comment-
 * glob issue described below). The wildcard matches every request —
 * including the page's own navigation — so if a preceding test's
 * route leaks into the next test's page (via Playwright context
 * collapse or any other cross-test pollution), the leaked mock fires
 * earlier than the test expects and the page renders before the
 * test's own fetch runs. The downstream symptom is a Playwright
 * "Resulting promise was garbage collected" race.
 *
 * See .scratch/backups-cross-test-pollution/issues/01.
 *
 * `behavior: 'ignoreErrors'` makes the call a no-op when no routes
 * are registered, so it's safe to run after every test.
 */
async function cleanRoutes(page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
}

module.exports = { cleanRoutes };
