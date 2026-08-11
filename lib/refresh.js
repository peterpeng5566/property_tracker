// lib/refresh.js — pure refresh state-machine (v1.2).
//
// Loaded by portfolio.html via <script src="lib/refresh.js"> (browser globals).
// Also imported by tests/refresh.test.js for Node.js testing (CommonJS).
//
// Source of truth for the retry / cancel / partial-success workflow
// previously inlined as `refreshAllPrices()` in portfolio.html.
//
// The library knows nothing about holdings, _refresh_failed, schema flags,
// i18n, or persistence — those concerns are the Alpine shim's job. Every
// collaborator is injected so tests can drive deterministic timing.
//
// Spec: .scratch/v1.2-testing-safety-net/issues/06-lib-refresh-extraction.md
// Cross-ref: docs/v1.1-spec.md §3 (retry semantics) + §9.2 (test scenarios).

(function (root) {
  'use strict';

  // ---- Defaults ----

  const DEFAULT_MAX_ATTEMPTS = 5;
  const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
  const defaultBackoffMs = (n) => DEFAULT_BACKOFF_MS[n - 1] ?? 0;
  const defaultIsCancelled = () => false;
  // Yahoo-shaped per-symbol failures carry `failed: true`. Tests can
  // inject a different isFailed to cover other shapes (e.g. {ok:false}).
  const defaultIsFailed = (r) => !!(r && r.failed === true);

  // ---- runRefresh ----

  // Run the retry loop and return a summary.
  //
  // Options:
  //   symbols        — array of tickers to refresh (order preserved in
  //                    returned succeeded / failed arrays).
  //   fetchQuotes    — async fn(symbols) → { [sym]: result | {failed:true} | undefined }
  //                    Missing entries are treated as failed.
  //   maxAttempts    — default 5.
  //   backoffMs(n)   — ms to sleep after attempt n (1-based). Default
  //                    exponential: 1s, 2s, 4s, 8s, 16s.
  //   sleep(ms)      — promise factory. Default setTimeout-based.
  //   isCancelled()  — boolean. Default () => false.
  //   isFailed(r)    — predicate over a per-symbol result. Default e?.failed === true.
  //   onAttempt({attempt,pending,results}) — fires after each attempt's
  //                    recompute. Errors are swallowed.
  //
  // Return: { attempts, succeeded, failed, cancelled }.
  //   attempts   — number of fetchQuotes calls that resolved (0 if symbols empty).
  //   succeeded  — symbols that got a non-failed result at some point.
  //   failed     — symbols still pending at loop exit (after retry exhaust,
  //                cancel, or initial empty state).
  //   cancelled  — true if isCancelled() broke the loop.
  //
  // Semantics pinned by tests/refresh.test.js:
  //   - attempt 1 does NOT check isCancelled at the loop head
  //   - attempts 2+ check isCancelled BEFORE and AFTER each fetch
  //   - in-flight fetchQuotes is never aborted
  //   - onAttempt throwing is swallowed (loop continues)
  //   - no sleep is scheduled after the final attempt

  async function runRefresh(opts) {
    const {
      symbols,
      fetchQuotes,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      backoffMs = defaultBackoffMs,
      sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
      isCancelled = defaultIsCancelled,
      isFailed = defaultIsFailed,
      onAttempt,
    } = opts;

    const allSymbols = Array.isArray(symbols) ? symbols.slice() : [];
    const stillPending = new Set(allSymbols);
    const succeeded = new Set();
    const results = {};
    let attempts = 0;
    let cancelled = false;

    for (let attempt = 1; attempt <= maxAttempts && stillPending.size > 0; attempt++) {
      // Head cancel check: only for attempts 2+ (per spec).
      if (attempt > 1 && isCancelled()) {
        cancelled = true;
        break;
      }

      let partial;
      try {
        partial = await fetchQuotes([...stillPending]);
      } catch (e) {
        // Catastrophic failure (auth/network/parse). Per v1.1 §3.5, the
        // Alpine shim wraps fetchQuotes to convert throws to {failed:true}
        // results if needed; here we just bail and return what we have.
        // No rethrow — callers shouldn't have to wrap in try/catch.
        break;
      }

      attempts = attempt;

      // Merge fresh results into the per-symbol map. Only overwrite for
      // symbols still in the pending set (defensive against weird
      // fetchQuotes implementations that echo back retired symbols).
      for (const sym of Object.keys(partial || {})) {
        if (stillPending.has(sym)) {
          results[sym] = partial[sym];
        }
      }

      // Recompute succeeded/failed after each attempt. Symbols with no
      // entry in `results` (missing from the response) count as failed.
      for (const sym of [...stillPending]) {
        const r = results[sym];
        if (r != null && !isFailed(r)) {
          succeeded.add(sym);
          stillPending.delete(sym);
        }
      }

      // Per-attempt callback (errors swallowed).
      if (onAttempt) {
        try {
          onAttempt({
            attempt,
            pending: [...stillPending],
            results: { ...results },
          });
        } catch (_) { /* swallow per spec */ }
      }

      // Tail cancel check (every attempt, incl. attempt 1). Comes BEFORE
      // the stillPending-empty break so a cancel flipped inside onAttempt
      // is observable in the return value.
      if (isCancelled()) {
        cancelled = true;
        break;
      }

      // All done? Break before the sleep.
      if (stillPending.size === 0) break;

      // No sleep after the final attempt.
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
      }
    }

    return {
      attempts,
      succeeded: [...succeeded],
      failed: [...stillPending],
      cancelled,
    };
  }

  const api = { runRefresh };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    // Browser. Load order is independent — no dependency on other lib
    // globals (Refresh is fully self-contained).
    root.Refresh = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
