// lib/rebalance.js — pure rebalance advisor (v1.8 + v1.19 + v1.20).
//
// Loaded by portfolio.html via <script src="lib/rebalance.js"> (browser globals).
// Also imported by tests/rebalance.test.js for Node.js testing (CommonJS).
//
// Source of truth for the v1.8 rebalance advisor (ADR 0017), the
// v1.19 per-rule visibility toggle (ADR 0025), and the v1.20
// bucket-weighted target display (ADR 0026):
//   - Each Plan rule carries an optional `target_weight_pct` field
//     (additive, schema stays at '1.1' per ADR 0009 §6).
//   - v1.19 adds an optional `show_in_rebalance: boolean` field.
//     Both `target_weight_pct` is set AND `show_in_rebalance === true`
//     are required for the rule to be "rebalance-eligible". New rules
//     default `show_in_rebalance: false` (off); pre-v1.19 rules with
//     no field are treated as off (the user must opt in via the plan
//     editor checkbox).
//   - When eligible, the lib computes a per-rule
//     target_value = total_portfolio_value × target_weight_pct, then
//     splits that by the rule's `distribute` weights per bucket
//     (v1.20, ADR 0026). Each bucket's per-record candidate row
//     receives the full bucket target (NOT divided by bucket count)
//     and the full bucket delta (NOT divided by bucket count). The
//     user picks which row(s) within a bucket to execute.
//   - Records carry an explicit `kind: 'holding' | 'cash'` tag (set by
//     the Alpine shim at the call site) so the lib can branch on type
//     without coupling to the holdings/cash_accounts shape.
//   - FX conversion goes through lib/format.js toTWD/fromTWD so the
//     conversion rule lives in one place.
//
// Pure: receives all inputs as parameters, never reads globals or DOM.
// Mutates nothing; returns new arrays from executeCandidate.

(function (root) {
  'use strict';

  const { toTWD, fromTWD } = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./format.js')
    : { toTWD: root.toTWD, fromTWD: root.fromTWD };

  const { recordsMatchingRule } = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./plan.js')
    : root.Plan;

  // ---- Local helpers ----

  // _isPlainObject — duplicates lib/plan.js's private helper (kept
  // private there to avoid an export surface). For rebalance.js we
  // need the same check at the rule.distribute boundary.
  function _isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  // ---- Eligibility ----

  // A rule is rebalance-eligible iff:
  //   - target_weight_pct is a finite number in [0, 100]
  //     (v1.8 / ADR 0017 §1); AND
  //   - show_in_rebalance === true (v1.19 / ADR 0025).
  // The second condition is the user opt-in for rebalance advice. The
  // default (rule absent of `show_in_rebalance` OR explicitly false)
  // filters the rule out so the Rebalance page shows only rules the
  // user has explicitly chosen to track for rebalance — independent
  // from drift eligibility (a rule can be drift-tracked without being
  // rebalance-eligible, and vice-versa). Pre-v1.19 plans (no field)
  // are NOT auto-on: they become drift-only on the Rebalance page
  // until the user ticks the per-rule checkbox.
  //
  // The same predicate is used by both computeCandidates and
  // computeTotalDrift so they agree on what's "eligible".
  function _isEligible(rule) {
    if (!rule || typeof rule !== 'object') return false;
    const tw = rule.target_weight_pct;
    if (tw === undefined || tw === null) return false;
    if (typeof tw !== 'number' || !Number.isFinite(tw)) return false;
    if (tw < 0 || tw > 100) return false;
    // Strict === true: undefined / null / false / "true" (string) /
    // 1 (number) all → not eligible. The UI only writes a real boolean.
    if (rule.show_in_rebalance !== true) return false;
    return true;
  }

  // ---- Bucket split (v1.20, ADR 0026) ----

  // Returns per-bucket target/current/delta/count in baseline TWD, and
  // an `_unassigned` bucket for matched records that lack the distribute
  // attribute. Per-row target = bucket target (NOT divided by bucket
  // count); per-row Δ = bucket delta (NOT divided by bucket count).
  //
  // If the rule has no `distribute`, we fall back to a synthetic `_all`
  // bucket (signalled by `targetCatId === null`) with weight 100% (= the
  // whole rule) so the per-row semantics stay consistent: per-row target
  // = whole rule_target, no division by matchedCount. This is a
  // deliberate behaviour change from v1.8 (ADR 0017 §4) but matches the
  // v1.20 principle: same number on every row in the same bucket, never
  // divided.
  function _splitTargetsByBucket(rule, matched, ruleTargetTwd, fxRate) {
    const distribute = (rule && _isPlainObject(rule.distribute)) ? rule.distribute : null;
    const distKeys = distribute ? Object.keys(distribute) : [];

    if (distKeys.length === 0) {
      // No distribute: synthetic _all bucket, weight 100%.
      let current = 0;
      let count = 0;
      for (const rec of matched) {
        const v = typeof rec.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
        const c = rec.currency || 'TWD';
        current += toTWD(v, c, fxRate);
        count++;
      }
      return {
        targetCatId: null,
        buckets: {
          _all: { target: ruleTargetTwd, current, delta: ruleTargetTwd - current, count },
        },
        unassigned: null,
      };
    }

    const targetCatId = distKeys[0];
    const weights = distribute[targetCatId];
    const buckets = {};
    for (const vid of Object.keys(weights)) {
      const w = weights[vid];
      if (typeof w === 'number' && Number.isFinite(w) && w >= 0) {
        const target = ruleTargetTwd * w / 100;
        buckets[vid] = { target, current: 0, delta: 0, count: 0 };
      }
    }

    const unassigned = { target: 0, current: 0, delta: 0, count: 0 };

    for (const rec of matched) {
      const v = typeof rec.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
      const c = rec.currency || 'TWD';
      const twd = toTWD(v, c, fxRate);
      const attrs = rec.attributes;
      const vid = attrs && typeof attrs === 'object' ? attrs[targetCatId] : undefined;
      if (vid && Object.prototype.hasOwnProperty.call(buckets, vid)) {
        buckets[vid].current += twd;
        buckets[vid].count++;
      } else {
        unassigned.current += twd;
        unassigned.count++;
      }
    }

    for (const vid of Object.keys(buckets)) {
      buckets[vid].delta = buckets[vid].target - buckets[vid].current;
    }
    unassigned.delta = unassigned.target - unassigned.current; // = -current

    return { targetCatId, buckets, unassigned };
  }

  // Look up the right bucket for a single record (extracts the
  // distribute-attribute lookup shared between the split helper and
  // computeCandidates' matchedRecords map). Returns the bucket object
  // (target, current, delta, count); never null.
  function _bucketForRecord(rec, split) {
    if (split.targetCatId === null) {
      return split.buckets._all;
    }
    const attrs = rec.attributes;
    const vid = attrs && typeof attrs === 'object' ? attrs[split.targetCatId] : undefined;
    if (vid && split.buckets[vid]) return split.buckets[vid];
    return split.unassigned;
  }

  // ---- Per-record candidate computation ----

  // For one matched record, compute its candidate row.
  //   bucketTargetTwd — the bucket's target value in baseline currency
  //     (TWD). Equal across all records in the same bucket per v1.20
  //     (ADR 0026 §1).
  //   bucketDeltaTwd — the bucket's delta (bucketTarget - bucketCurrent)
  //     in baseline currency. Equal across all records in the same
  //     bucket per v1.20 (ADR 0026 §1).
  //   fxRate — baseline = TWD; fxRate = TWD/USD rate.
  //
  // Per-record fields (targetValue, delta, targetShares, deltaShares,
  // targetBalance, deltaAmount) are in the record's NATIVE currency so
  // the UI shows e.g. "+1250 USD" instead of "NT$X TWD" for a USD
  // holding. The display rule is "per-row = bucket", never divided by
  // bucket count.
  function _buildCandidateRecord(rec, bucketTargetTwd, bucketDeltaTwd, fxRate) {
    const recValue = typeof rec.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
    const currency = rec.currency || 'TWD';

    // Back-convert bucket amounts from baseline TWD to the record's
    // native currency for per-record display and per-share / per-unit
    // arithmetic. (NOT divided by bucket count.)
    const targetNative = fromTWD(bucketTargetTwd, currency, fxRate);
    const deltaNative = fromTWD(bucketDeltaTwd, currency, fxRate);

    const base = {
      recordId: rec.id,
      currency,
      currentValue: recValue,
      targetValue: targetNative,
      delta: deltaNative,
    };

    if (rec.kind === 'holding') {
      const currentShares = typeof rec.shares === 'number' && Number.isFinite(rec.shares) ? rec.shares : 0;
      const currentPrice = typeof rec.current_price === 'number' && Number.isFinite(rec.current_price) ? rec.current_price : 0;
      const targetShares = currentPrice > 0 ? targetNative / currentPrice : 0;
      const deltaShares = targetShares - currentShares;
      return Object.assign(base, {
        kind: 'holding',
        currentShares,
        currentPrice,
        targetShares,
        deltaShares,
        action: deltaShares >= 0 ? 'buy' : 'sell',
      });
    }

    // cash
    const currentBalance = typeof rec.balance === 'number' && Number.isFinite(rec.balance) ? rec.balance : 0;
    return Object.assign(base, {
      kind: 'cash',
      currentBalance,
      targetBalance: targetNative,
      deltaAmount: deltaNative,
      action: deltaNative >= 0 ? 'add' : 'reduce',
    });
  }

  // ---- computeCandidates ----

  // Returns an array of one entry per eligible rule. Each entry:
  //   { ruleId, ruleName, kind, targetValue, currentValue, delta,
  //     matchedRecords: [{ recordId, currency, currentValue,
  //       targetValue, delta, kind-specific fields... }] }
  //
  // Rule-level fields (targetValue / currentValue / delta) are in
  // baseline currency (TWD). Per-record fields are in the record's
  // native currency (so the user sees "$289 USD" not "₺ X TWD" for a
  // USD holding).
  //
  // rule.kind: 'cash' iff every matched record is a cash account;
  // otherwise 'holding' (mixed → holding wins as the default).
  function computeCandidates(plan, input) {
    if (!plan || !Array.isArray(plan.rules)) return [];
    const rules = plan.rules;
    const records = (input && input.records) || [];
    const totalValue = (input && typeof input.totalValue === 'number' && Number.isFinite(input.totalValue)) ? input.totalValue : 0;
    const fxRate = (input && typeof input.fxRate === 'number' && Number.isFinite(input.fxRate)) ? input.fxRate : 1;

    const out = [];
    for (const rule of rules) {
      if (!_isEligible(rule)) continue;

      const ruleTargetValueBaseline = (rule.target_weight_pct / 100) * totalValue;
      const matched = recordsMatchingRule(rule, records, undefined);
      const matchedCount = matched.length;

      // Sum matched records' values in baseline currency.
      let ruleCurrentValueBaseline = 0;
      for (const rec of matched) {
        const v = typeof rec.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
        const c = rec.currency || 'TWD';
        ruleCurrentValueBaseline += toTWD(v, c, fxRate);
      }

      // Rule kind: cash if every matched record is a cash account.
      let allCash = matchedCount > 0;
      for (const rec of matched) {
        if (rec.kind !== 'cash') { allCash = false; break; }
      }
      const ruleKind = matchedCount === 0 ? 'holding' : (allCash ? 'cash' : 'holding');

      // v1.20 bucket-aware split (ADR 0026). Each record's target and
      // delta come from its bucket, NOT divided by bucket count.
      const split = _splitTargetsByBucket(rule, matched, ruleTargetValueBaseline, fxRate);

      const matchedRecords = matched.map(rec => {
        const bucket = _bucketForRecord(rec, split);
        return _buildCandidateRecord(rec, bucket.target, bucket.delta, fxRate);
      });

      out.push({
        ruleId: rule.id,
        ruleName: rule.name || '',
        kind: ruleKind,
        targetValue: ruleTargetValueBaseline,
        currentValue: ruleCurrentValueBaseline,
        delta: ruleTargetValueBaseline - ruleCurrentValueBaseline,
        matchedRecords,
      });
    }

    return out;
  }

  // ---- computeTotalDrift ----

  // Returns { drift, totalRuleWeight, missing }.
  //   drift — sum of |delta| across all eligible rules, in baseline
  //     currency. Honest: even with no candidates (matchedCount=0) the
  //     rule contributes |target_value| to the drift total so the user
  //     sees "I haven't bought anything yet" as drift.
  //   totalRuleWeight — sum of rule.target_weight_pct for eligible
  //     rules. Informational; should sum to 100 for a complete plan.
  //   missing — 100 - totalRuleWeight. Negative if the plan exceeds
  //     100% (sanity helper for UI).
  function computeTotalDrift(plan, input) {
    const candidates = computeCandidates(plan, input);
    let drift = 0;
    let totalRuleWeight = 0;
    for (const entry of candidates) {
      drift += Math.abs(entry.delta);
    }
    if (plan && Array.isArray(plan.rules)) {
      for (const rule of plan.rules) {
        if (_isEligible(rule)) totalRuleWeight += rule.target_weight_pct;
      }
    }
    return { drift, totalRuleWeight, missing: 100 - totalRuleWeight };
  }

  // ---- executeCandidate ----

  // Pure: returns { holdings, cash_accounts } with the target record
  // updated by `intent`. The caller (Alpine shim) is responsible for
  // stamping `updated_at` on the touched record (ADR 0016 §6 edit-path
  // stamp) and for persisting the result via the existing save path.
  //
  // intent shape:
  //   { kind: 'holding', deltaShares: number }
  //   { kind: 'cash', deltaAmount: number }
  //
  // Record-not-found: returns the input state unchanged (so the UI can
  // optimistically re-render without a guard).
  function executeCandidate(state, ruleId, recordId, intent) {
    const holdings = (state && state.holdings) ? state.holdings.slice() : [];
    const cash_accounts = (state && state.cash_accounts) ? state.cash_accounts.slice() : [];

    if (!intent || !intent.kind) return { holdings, cash_accounts };

    if (intent.kind === 'holding') {
      const idx = holdings.findIndex(h => h && h.id === recordId);
      if (idx === -1) return { holdings, cash_accounts };
      const delta = typeof intent.deltaShares === 'number' && Number.isFinite(intent.deltaShares) ? intent.deltaShares : 0;
      const next = Object.assign({}, holdings[idx]);
      next.shares = (typeof next.shares === 'number' ? next.shares : 0) + delta;
      holdings[idx] = next;
    } else if (intent.kind === 'cash') {
      const idx = cash_accounts.findIndex(c => c && c.id === recordId);
      if (idx === -1) return { holdings, cash_accounts };
      const delta = typeof intent.deltaAmount === 'number' && Number.isFinite(intent.deltaAmount) ? intent.deltaAmount : 0;
      const next = Object.assign({}, cash_accounts[idx]);
      next.balance = (typeof next.balance === 'number' ? next.balance : 0) + delta;
      cash_accounts[idx] = next;
    }

    return { holdings, cash_accounts };
  }

  // ---- Public API ----

  const api = {
    computeCandidates,
    computeTotalDrift,
    executeCandidate,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    // Browser (portfolio.html). Load order: lib/format.js → lib/plan.js
    // → lib/rebalance.js so toTWD / fromTWD / recordsMatchingRule
    // resolve through root globals at IIFE-evaluation time.
    root.Rebalance = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
