// tests/refresh.test.js — tests for lib/refresh.js (v1.2)
//
// Covers the five spec §9.2 retry scenarios plus partition edge cases.
// Source of truth: lib/refresh.js + .scratch/v1.2-testing-safety-net/
//   issues/06-lib-refresh-extraction.md.
//
// The refresh state machine is now a pure function with injected
// collaborators (fetchQuotes, sleep, isCancelled, isFailed, onAttempt,
// backoffMs). All scenarios inject sleep + backoffMs so node:test runs
// take milliseconds, not seconds.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Refresh = require('../lib/refresh.js');

// ---- Test helpers ----

// A successful Yahoo-shaped result. {failed: true} is what yahoo.js
// returns for per-symbol failures.
function okFor(sym) {
  return {
    ok: true,
    current_price: 100,
    high_52w: 110,
    low_52w: 90,
    prev_close: 95,
  };
}

function failFor(sym) {
  return { ok: false, failed: true };
}

// Make a fetchQuotes whose i-th call returns the i-th mapping. If the
// caller makes more calls than there are mappings, the last mapping is
// reused (so "still failing" scenarios just put one mapping).
//
// Each step is either:
//   - a function (syms) => { [sym]: result } — called with the request
//   - an object { [sym]: result } — filtered to the requested syms
function scriptedFetch(...steps) {
  let callIndex = 0;
  return async (syms) => {
    const step = steps[Math.min(callIndex, steps.length - 1)];
    callIndex++;
    if (typeof step === 'function') return step(syms);
    const out = {};
    for (const s of syms) {
      if (Object.prototype.hasOwnProperty.call(step, s)) out[s] = step[s];
    }
    return out;
  };
}

// All successes in one shot.
function allOK(syms) {
  const out = {};
  for (const s of syms) out[s] = okFor(s);
  return out;
}

// All failures in one shot.
function allFail(syms) {
  const out = {};
  for (const s of syms) out[s] = failFor(s);
  return out;
}

// Promise-resolving no-op sleep.
const noSleep = () => Promise.resolve();

// No-wait backoff (default in tests).
const noBackoff = () => 0;

// Default injection set used by most tests. Spreading this MUST come BEFORE
// any caller-provided sleep / backoffMs so the caller's overrides win.
//
// Usage:
//   Refresh.runRefresh({ symbols, fetchQuotes, ...defaults() })
//   Refresh.runRefresh({ symbols, fetchQuotes, sleep: mySleep, backoffMs: myBackoff })
function defaults(opts = {}) {
  return {
    sleep: noSleep,
    backoffMs: noBackoff,
    ...opts,
  };
}

// ---- §9.2 spec scenarios ----

test('§9.2 #1: all succeed on first try → 1 attempt, no retries', async () => {
  const fetchQuotes = scriptedFetch(allOK);
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 1);
  assert.deepEqual(res.succeeded.sort(), ['A', 'B', 'C']);
  assert.deepEqual(res.failed, []);
  assert.equal(res.cancelled, false);
});

test('§9.2 #2: some fail, second try succeeds → 2 attempts, all updated', async () => {
  const fetchQuotes = scriptedFetch(
    { A: okFor('A'), B: failFor('B'), C: okFor('C') }, // attempt 1
    { B: okFor('B') },                                  // attempt 2
  );
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 2);
  assert.deepEqual(res.succeeded.sort(), ['A', 'B', 'C']);
  assert.deepEqual(res.failed, []);
  assert.equal(res.cancelled, false);
});

test('§9.2 #3: all 5 attempts fail → 5 attempts, all in failed', async () => {
  const fetchQuotes = scriptedFetch(allFail);
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 5);
  assert.deepEqual(res.succeeded, []);
  assert.deepEqual(res.failed.sort(), ['A', 'B']);
  assert.equal(res.cancelled, false);
});

test('§9.2 #4: user cancels after attempt 1 → cancelled=true, succeeded includes initial wins', async () => {
  // First attempt: A succeeds, B fails. Cancel is set right after.
  // Expected: attempts=1 (cancel after attempt 1, before retry begins),
  // succeeded includes A (got result), failed includes B (was pending).
  const fetchQuotes = scriptedFetch({
    A: okFor('A'),
    B: failFor('B'),
  });
  let afterFirst = false;
  const isCancelled = () => afterFirst;

  // Make the onAttempt flip the cancel flag on the first call so the
  // after-attempt-1 cancel check fires.
  const onAttempt = () => {
    afterFirst = true;
  };

  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    isCancelled,
    onAttempt,
    ...defaults(),
  });

  assert.equal(res.attempts, 1);
  assert.deepEqual(res.succeeded, ['A']);
  assert.deepEqual(res.failed, ['B']);
  assert.equal(res.cancelled, true);
});

test('§9.2 #5: mixed success/failure across attempts → 3 attempts, all updated', async () => {
  // Pattern: A={ok}, B={failed}, C={failed}
  //   attempt 1 → A succeeds; pending={B,C}; B fails, C fails
  //   attempt 2 → B={ok}, C={failed}; pending={C}; C fails
  //   attempt 3 → C={ok}
  const fetchQuotes = scriptedFetch(
    { A: okFor('A'), B: failFor('B'), C: failFor('C') },
    { B: okFor('B'), C: failFor('C') },
    { C: okFor('C') },
  );
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 3);
  assert.deepEqual(res.succeeded.sort(), ['A', 'B', 'C']);
  assert.deepEqual(res.failed, []);
  assert.equal(res.cancelled, false);
});

// ---- Partition edge cases ----

test('empty symbols → attempts: 0, no fetch, all arrays empty', async () => {
  let called = false;
  const fetchQuotes = async () => { called = true; return {}; };
  const res = await Refresh.runRefresh({
    symbols: [],
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 0);
  assert.deepEqual(res.succeeded, []);
  assert.deepEqual(res.failed, []);
  assert.equal(res.cancelled, false);
  assert.equal(called, false, 'fetchQuotes should not be called for empty symbols');
});

test('missing symbol (in symbols but not in results) is treated as failed', async () => {
  // Yahoo may omit a ticker from results entirely (e.g., delisted). That
  // should count as failed in the final report.
  const fetchQuotes = scriptedFetch({
    A: okFor('A'),
    // B intentionally missing
  });
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    ...defaults(),
  });
  assert.deepEqual(res.succeeded.sort(), ['A']);
  assert.deepEqual(res.failed, ['B']);
});

test('isFailed injection: custom failure shape is recognized', async () => {
  // inject isFailed so that `{ok: false}` (a non-Yahoo shape) is treated
  // as a failure. fetchQuotes returns both ok:false and ok:true results.
  const fetchQuotes = scriptedFetch({
    A: { ok: false },
    B: { ok: true },
  });
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    isFailed: (r) => r.ok === false,
    ...defaults(),
  });
  assert.deepEqual(res.succeeded, ['B']);
  assert.deepEqual(res.failed, ['A']);
});

test('onAttempt throwing is swallowed; loop continues to completion', async () => {
  // onAttempt throws on every call. fetchQuotes follows §9.2 #5 (3 attempts).
  let onAttemptCalls = 0;
  const fetchQuotes = scriptedFetch(
    { A: okFor('A'), B: failFor('B'), C: failFor('C') },
    { B: okFor('B'), C: failFor('C') },
    { C: okFor('C') },
  );
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    onAttempt: () => {
      onAttemptCalls++;
      throw new Error('boom from onAttempt');
    },
    ...defaults(),
  });
  assert.equal(onAttemptCalls, 3, 'onAttempt should fire on each attempt');
  assert.equal(res.attempts, 3);
  assert.deepEqual(res.succeeded.sort(), ['A', 'B', 'C']);
});

test('backoffMs injection yields deterministic timing', async () => {
  // Inject a backoff that records each value requested. Default delays
  // are [1000,2000,4000,8000,16000]. We override with a known pattern.
  const backoffCalls = [];
  const customBackoff = (n) => {
    backoffCalls.push(n);
    return 5;
  };

  // Use a sleep that counts calls. Three successful attempts (one per
  // symbol) means 2 sleeps (after attempt 1, after attempt 2).
  const sleep = (ms) => {
    assert.equal(ms, 5);
    return Promise.resolve();
  };

  const fetchQuotes = scriptedFetch(
    { A: okFor('A'), B: failFor('B'), C: failFor('C') },
    { B: okFor('B'), C: failFor('C') },
    { C: okFor('C') },
  );

  const res = await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    backoffMs: customBackoff,
    sleep,
  });

  assert.equal(res.attempts, 3);
  // backoffMs is called with attempt numbers (1-based) for sleeps AFTER
  // attempts 1, 2, 3 (max=5 default). Sleeps happen after attempts 1-4.
  // So backoffMs is called for n=1, n=2, then no more (pending empty).
  assert.deepEqual(backoffCalls, [1, 2]);
});

test('cancel during attempt 1 still records succeeded (after-fetch check fires)', async () => {
  // All succeed on attempt 1, but cancel flips on the after-fetch check.
  const fetchQuotes = scriptedFetch(allOK);
  let afterFirst = false;
  const isCancelled = () => afterFirst;
  const onAttempt = () => { afterFirst = true; };

  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    isCancelled,
    onAttempt,
    ...defaults(),
  });
  assert.deepEqual(res.succeeded.sort(), ['A', 'B']);
  assert.deepEqual(res.failed, []);
  assert.equal(res.cancelled, true);
});

test('cancel between attempts: head check on attempt 2 catches it (succinct)', async () => {
  // isCancelled is true the moment we enter the sleep between attempt 1
  // and attempt 2. attempt 2's head check should fire and break.
  const fetchQuotes = scriptedFetch(allFail);
  let inSleep = false;
  const isCancelled = () => inSleep;
  let sleepCount = 0;
  const sleep = () => {
    sleepCount++;
    inSleep = true; // flip cancel flag during the inter-attempt sleep
    return Promise.resolve();
  };

  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    isCancelled,
    sleep,
    backoffMs: () => 0,
  });
  assert.equal(sleepCount, 1, 'sleep fires once (between attempt 1 and 2)');
  assert.equal(res.attempts, 1, 'attempt 1 ran, attempt 2 was skipped by head check');
  assert.equal(res.cancelled, true);
  assert.deepEqual(res.failed.sort(), ['A', 'B']);
});

test('default isCancelled is () => false: loop never cancels', async () => {
  const fetchQuotes = scriptedFetch(allOK);
  const res = await Refresh.runRefresh({
    symbols: ['A'],
    fetchQuotes,
    ...defaults(),
    // no isCancelled → default
  });
  assert.equal(res.cancelled, false);
});

test('default isFailed treats e?.failed === true as failed', async () => {
  // Default isFailed should recognize Yahoo's `{failed: true}` shape.
  const fetchQuotes = scriptedFetch({
    A: { failed: true, error: 'TIMEOUT' },
    B: { ok: true, current_price: 100 },
  });
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    ...defaults(),
  });
  assert.deepEqual(res.succeeded, ['B']);
  assert.deepEqual(res.failed, ['A']);
});

test('onAttempt receives { attempt, pending, results }', async () => {
  // All succeed on attempt 1 — single attempt expected.
  const fetchQuotes = scriptedFetch(allOK);
  const observed = [];
  await Refresh.runRefresh({
    symbols: ['A', 'B', 'C'],
    fetchQuotes,
    onAttempt: (info) => { observed.push(info); },
    ...defaults(),
  });

  assert.equal(observed.length, 1, 'only one attempt needed');
  assert.equal(observed[0].attempt, 1);
  assert.deepEqual(observed[0].pending, []);
  assert.deepEqual(observed[0].results, {
    A: okFor('A'),
    B: okFor('B'),
    C: okFor('C'),
  });
});

test('no sleep is called after the final attempt', async () => {
  // All 5 attempts fail. Sleeps should happen after attempts 1-4 only,
  // NOT after attempt 5 (which is the final attempt).
  let sleepCount = 0;
  const sleep = () => {
    sleepCount++;
    return Promise.resolve();
  };

  const fetchQuotes = scriptedFetch(allFail);
  await Refresh.runRefresh({
    symbols: ['A'],
    fetchQuotes,
    sleep,
    backoffMs: () => 1,
  });

  assert.equal(sleepCount, 4, 'sleep should fire after attempts 1, 2, 3, 4 but not 5');
});

test('module is pure — no knowledge of holdings, _refresh_failed, or schema flags', async () => {
  // We can prove purity simply by running a refresh with arbitrary
  // symbol strings. They don't need to match real ticker shapes.
  const weirdSymbols = ['__weird__', 'with spaces', '中文', '123'];
  const fetchQuotes = scriptedFetch(
    Object.fromEntries(weirdSymbols.map(s => [s, okFor(s)])),
  );
  const res = await Refresh.runRefresh({
    symbols: weirdSymbols,
    fetchQuotes,
    ...defaults(),
  });
  assert.equal(res.attempts, 1);
  assert.deepEqual(res.succeeded.sort(), weirdSymbols.slice().sort());
  assert.deepEqual(res.failed, []);
});

test('in-flight fetch is not aborted on cancel signal', async () => {
  // If cancel flips DURING the fetch, the fetch still completes and the
  // result is merged. Cancel is only checked AFTER the fetch resolves.
  const fetchQuotes = async (syms) => {
    // Simulate a slow fetch that should not be cancelled.
    await Promise.resolve();
    return allOK(syms);
  };
  let afterFirst = false;
  // Cancel only after fetch (simulating user clicking "cancel" while the
  // request is in flight — but in real life the click happens after the
  // user sees the loading state).
  const res = await Refresh.runRefresh({
    symbols: ['A', 'B'],
    fetchQuotes,
    isCancelled: () => afterFirst,
    onAttempt: () => { afterFirst = true; },
    ...defaults(),
  });
  // The fetch for attempt 1 already returned; onAttempt fired (flipping
  // afterFirst=true); the cancel check on attempt 2 would fire next,
  // but stillPending is empty after attempt 1 → loop breaks via the
  // stillPending check, not the cancel check.
  assert.deepEqual(res.succeeded.sort(), ['A', 'B']);
  assert.equal(res.attempts, 1);
});
