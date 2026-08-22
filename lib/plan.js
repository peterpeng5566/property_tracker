// lib/plan.js — pure plan/rule/drift helpers (v1.4).
//
// Loaded by portfolio.html via <script src="lib/plan.js"> (browser globals).
// Also imported by tests/plan.test.js for Node.js testing (CommonJS).
//
// Source of truth for the Plan data model + validation + rule matching +
// distribution + drift math. The Alpine shim (portfolio.html) is a thin
// wrapper that constructs the `records` and `recordsAttributes` inputs
// from data.holdings / data.cash_accounts / data.debts and calls into
// these pure functions. See docs/adr (planned v1.4 ADR — ticket 06).
//
// Records passed in use a generic shape:
//   { id: string, currency: 'TWD' | 'USD', value: number }
// `value` is the per-record net-worth contribution in `currency`:
//   holdings: shares * current_price (positive)
//   cash accounts: balance (positive)
//   debts: -balance (negative — subtracts from net worth)
// The lib is agnostic to record type; the Alpine shim does the per-type
// extraction.
//
// `recordsAttributes` is a parallel lookup { recordId → { catId → valueId } }
// so the lib can filter and group without coupling to the holdings/cash/
// debts shape.
//
// FX conversion goes through lib/format.js toTWD so the conversion rule
// lives in one place. fxRate is passed explicitly so tests don't need a
// browser.
//
// Spec: .scratch/v1.4-target-allocation-plans/issues/01-plan-data-model.md.

(function (root) {
  'use strict';

  // Pull FX conversion rule from lib/format.js so the rule lives in one
  // place. Node: require() the module. Browser: format.js has already
  // exposed toTWD on the global root via its own IIFE.
  const { toTWD } = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./format.js')
    : { toTWD: root.toTWD };

  // ---- ID generators ----

  // Mirrors the genId pattern used elsewhere in the app (mergeById-friendly
  // sortable ids with a prefix + timestamp + random suffix).
  function _genId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function newPlan(name) {
    return { id: _genId('plan'), name, rules: [] };
  }

  function newRule() {
    // v1.4 T04-prep retroactive: rule name is required (validated by
    // validateRule below). Starts empty so the editor disables Save
    // until the user types a name — matches the existing
    // `sum to 100%` and `name required` inline-error pattern.
    //
    // v1.19 (ADR 0025): show_in_rebalance defaults to false. The rule
    // is NOT rebalance-eligible until the user ticks the explicit
    // "Show in rebalance page" checkbox in the plan editor. Pre-v1.19
    // rules (no field) are treated as false by lib/rebalance.js
    // `_isEligible` (strict `=== true`), so the new default matches
    // the storage-of-truth on upgrade.
    return {
      id: _genId('rule'),
      name: '',
      when: {},
      distribute: {},
      show_in_rebalance: false,
    };
  }

  // ---- Validation ----

  // FP epsilon for the distribute-weight-sum check. 0.01 covers hand-edited
  // JSON and 2-decimal rounding without letting real bugs through.
  const WEIGHT_SUM_EPSILON = 0.01;

  function _isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Validate one rule. The contract does NOT require category ids
  // referenced by when / distribute to exist — that check belongs in
  // the UI layer so a user can save a plan referencing a category
  // they just deleted. Delete-protection flows through
  // plansReferencingCategory instead.
  function validateRule(rule) {
    const errors = [];

    if (!_isPlainObject(rule)) {
      return { valid: false, errors: ['Rule must be an object'] };
    }

    // ---- name ----
    // v1.4 T04-prep retroactive: required at save time (UI disables
    // Save while any rule name is empty). String, non-empty after
    // trim. Missing / empty / non-string / whitespace-only → invalid.
    if (typeof rule.name !== 'string' || rule.name.trim().length === 0) {
      errors.push('Rule name must be a non-empty string');
    }

    // ---- when ----
    if (rule.when !== undefined && rule.when !== null) {
      if (!_isPlainObject(rule.when)) {
        errors.push('when must be a plain object');
      } else {
        for (const catId of Object.keys(rule.when)) {
          const values = rule.when[catId];
          if (!Array.isArray(values)) {
            errors.push(`when.${catId} must be an array of value ids`);
          } else if (!values.every(v => typeof v === 'string' && v.length > 0)) {
            errors.push(`when.${catId} must be an array of non-empty strings`);
          }
        }
      }
    }

    // ---- distribute ----
    if (!_isPlainObject(rule.distribute)) {
      errors.push('distribute must be a plain object');
    } else {
      const keys = Object.keys(rule.distribute);
      if (keys.length === 0) {
        errors.push('distribute must have exactly 1 key (target category)');
      } else if (keys.length > 1) {
        errors.push(`distribute must have exactly 1 key, got ${keys.length}`);
      } else {
        const targetCatId = keys[0];
        const weights = rule.distribute[targetCatId];
        if (!_isPlainObject(weights)) {
          errors.push(`distribute.${targetCatId} must be an object mapping valueId → weight`);
        } else if (Object.keys(weights).length === 0) {
          errors.push(`distribute.${targetCatId} must have at least one value with a weight`);
        } else {
          let sum = 0;
          for (const valueId of Object.keys(weights)) {
            const w = weights[valueId];
            if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
              errors.push(`distribute.${targetCatId}.${valueId} must be a non-negative finite number`);
            } else {
              sum += w;
            }
          }
          if (Math.abs(sum - 100) > WEIGHT_SUM_EPSILON) {
            errors.push(`distribute weights must sum to 100, got ${sum}`);
          }
        }
      }
    }

    // ---- target_weight_pct (v1.8, ADR 0017 §1) ----
    // Optional. When set, marks the rule as rebalance-eligible; must be
    // a finite number in [0, 100]. Missing / null / undefined → rule
    // remains drift-only (existing v1.4 behaviour preserved).
    if (rule.target_weight_pct !== undefined && rule.target_weight_pct !== null) {
      const tw = rule.target_weight_pct;
      if (typeof tw !== 'number' || !Number.isFinite(tw)) {
        errors.push('target_weight_pct must be a finite number');
      } else if (tw < 0 || tw > 100) {
        errors.push('target_weight_pct must be between 0 and 100');
      }
    }

    // ---- show_in_rebalance (v1.19, ADR 0025) ----
    // Optional. When set, must be a boolean (true / false). Absent,
    // null, or undefined are treated as "not opted in" — equivalent
    // to false at the lib/rebalance.js eligibility check. Distinct
    // from `target_weight_pct`: a rule can be a drift-only rule (no
    // `target_weight_pct`) AND/OR a rebalance-eligible rule (both set
    // + `show_in_rebalance: true`). Home (Plan vs Actual) ignores
    // `show_in_rebalance`; only the Rebalance page filters on it.
    if (rule.show_in_rebalance !== undefined && rule.show_in_rebalance !== null) {
      if (typeof rule.show_in_rebalance !== 'boolean') {
        errors.push('show_in_rebalance must be a boolean');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  function validatePlan(plan, allPlans) {
    const errors = [];

    if (!_isPlainObject(plan)) {
      return { valid: false, errors: ['Plan must be an object'] };
    }

    // ---- name ----
    if (typeof plan.name !== 'string' || plan.name.trim().length === 0) {
      errors.push('Plan name must be a non-empty string');
    } else {
      // Uniqueness across allPlans EXCLUDING self (so editing a plan doesn't
      // trip on its own current name).
      const others = (allPlans || []).filter(p => p && p.id !== plan.id);
      if (others.some(p => p.name === plan.name)) {
        errors.push(`Plan name must be unique (duplicate: "${plan.name}")`);
      }
    }

    // ---- rules ----
    if (!Array.isArray(plan.rules)) {
      errors.push('Plan rules must be an array');
    } else if (plan.rules.length === 0) {
      errors.push('Plan must have at least 1 rule');
    } else {
      plan.rules.forEach((rule, i) => {
        const r = validateRule(rule);
        if (!r.valid) {
          for (const e of r.errors) errors.push(`Rule ${i + 1}: ${e}`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  // Whole-portfolio validation. The contract: `data.active_plan_id` is
  // a soft pointer (sync can race it ahead of plan deletions on another
  // device) — we WARN rather than reject so the app keeps running and
  // the UI can offer to either clear the pointer or restore the plan.
  function validatePlans(data) {
    const errors = [];
    const warnings = [];

    const plans = (data && data.plans) || [];
    const activePlanId = data && data.active_plan_id;

    if (activePlanId !== null && activePlanId !== undefined && activePlanId !== '') {
      const exists = plans.some(p => p && p.id === activePlanId);
      if (!exists) {
        warnings.push(`active_plan_id "${activePlanId}" does not reference any existing plan`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ---- Rule matching ----

  // Returns the slice of `records` whose attributes satisfy `rule.when`.
  // Semantics (per map.md):
  //   - Empty `when` → matches every record.
  //   - For each category in `when`, the record must have that attribute
  //     AND its value must appear in `when[cat]` (OR within category).
  //   - Across categories: AND (every category in `when` must match).
  //   - Missing attribute → record skipped.
  //   - Value id not in the list → record skipped.
  //
  // Attribute lookup priority:
  //   1. recordsAttributes[record.id] (the explicit per-record map).
  //   2. record.attributes (fallback when the caller passes records that
  //      already carry attributes inline — convenient for unit tests).
  function recordsMatchingRule(rule, records, recordsAttributes) {
    const recordsArr = records || [];
    const attrsMap = recordsAttributes || {};

    if (!rule || !_isPlainObject(rule.when)) {
      return recordsArr.slice();
    }
    const whenKeys = Object.keys(rule.when);
    if (whenKeys.length === 0) {
      return recordsArr.slice();
    }

    return recordsArr.filter(r => {
      const attrs = attrsMap[r.id] !== undefined ? attrsMap[r.id] : r.attributes;
      if (!_isPlainObject(attrs)) return false;
      return whenKeys.every(catId => {
        const allowed = rule.when[catId];
        const attrValue = attrs[catId];
        if (!attrValue) return false;
        if (!Array.isArray(allowed)) return false;
        return allowed.includes(attrValue);
      });
    });
  }

  // ---- Distribution ----

  // Group records by their attribute for `targetCategory`, summing
  // `record.value` (converted to TWD via fxRate) into a `{valueId: totalTWD}`
  // map. Records missing the target attribute are OMITTED (per spec) — the
  // lib does NOT bucket them as `_unassigned` here; that's a display
  // concern handled by driftForRule.
  function calcDistribution(records, targetCategory, recordsAttributes, fxRate) {
    const recordsArr = records || [];
    const attrsMap = recordsAttributes || {};
    const result = {};

    for (const r of recordsArr) {
      const attrs = attrsMap[r.id] !== undefined ? attrsMap[r.id] : r.attributes;
      if (!_isPlainObject(attrs)) continue;
      const valueId = attrs[targetCategory];
      if (!valueId) continue; // missing → omit
      const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : 0;
      const currency = r.currency || 'TWD';
      const twd = toTWD(value, currency, fxRate);
      result[valueId] = (result[valueId] || 0) + twd;
    }

    return result;
  }

  // ---- Drift ----

  // Compute drift for a single rule. Returned shape (per spec):
  //   { matching_total: number,
  //     actual: { [valueId]: pct, ...? },
  //     target: { [valueId]: pct },
  //     drift: { [valueId]: pct, ...? },
  //     rule_target_amount?: number,                    (v1.17, TWD)
  //     target_amount?: { [valueId]: number },         (v1.17, TWD)
  //     actual_amount?: { [valueId]: number },         (v1.17, TWD)
  //     drift_amount?: { [valueId]: number } }         (v1.17, TWD)
  //
  // Semantics:
  //   - matching_total = sum of all matching records' values (TWD).
  //   - actual[valueId] is normalized over records WITH the target attribute,
  //     so actual sums to 100% when at least one matching record has the
  //     target attribute. The _unassigned bucket is reported as
  //     actual._unassigned when records lack the attribute (pct of
  //     matching_total).
  //   - drift[valueId] = actual[valueId] - target[valueId]. Drift over
  //     target valueIds sums to 0 when records with target attribute exist.
  //   - Empty matching_total: actual = {}, drift = {}, target preserved.
  //   - All matching records lack target attribute: actual = { _unassigned:
  //     100 }, drift = {}, target preserved.
  //   - v1.17 amount fields are present only when `netWorth` is provided
  //     (additive, backward-compat). rule_target_amount = netWorth ×
  //     effective_target_weight_pct / 100, where effective_target_weight_pct
  //     treats missing/null as 100 (Home semantic, ADR 0024 §2). per value_id
  //     target_amount = rule_target_amount × distribute_weight[vid] / 100.
  //     actual_amount sums records' TWD values for that value_id (debt
  //     records contribute negatively). drift_amount = actual_amount -
  //     target_amount.
  //
  function driftForRule(rule, records, recordsAttributes, fxRate, netWorth) {

    if (!_isPlainObject(rule) || !_isPlainObject(rule.distribute)) {
      return { matching_total: 0, actual: {}, target: {}, drift: {} };
    }

    const targetKeys = Object.keys(rule.distribute);
    if (targetKeys.length === 0) {
      return { matching_total: 0, actual: {}, target: {}, drift: {} };
    }
    const targetCatId = targetKeys[0];
    const target = Object.assign({}, rule.distribute[targetCatId]);

    const matching = recordsMatchingRule(rule, records, recordsAttributes);

    // matching_total across all matching records (including those without
    // the target attribute).
    let matchingTotal = 0;
    for (const r of matching) {
      const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : 0;
      const currency = r.currency || 'TWD';
      matchingTotal += toTWD(value, currency, fxRate);
    }

    // v1.17 (ADR 0024 §2): treat missing target_weight_pct as 100 on the
    // Home page. Different from Rebalance (ADR 0017 §1, where missing = not
    // eligible). Computed only when netWorth is provided; absent otherwise.
    const hasNetWorth = typeof netWorth === 'number' && Number.isFinite(netWorth);
    let ruleTargetAmount = 0;
    let targetAmount = {};
    let actualAmount = {};
    let driftAmount = {};
    if (hasNetWorth) {
      const tw = rule.target_weight_pct;
      const effectiveWeight = (typeof tw === 'number' && Number.isFinite(tw)) ? tw : 100;
      ruleTargetAmount = netWorth * effectiveWeight / 100;
      // Per-value-id target_amount = rule_target_amount × distribute_weight / 100.
      targetAmount = {};
      for (const valueId of Object.keys(target)) {
        targetAmount[valueId] = ruleTargetAmount * target[valueId] / 100;
      }
    }

    if (matchingTotal === 0) {
      if (hasNetWorth) {
        // 0 matching but the rule still has a target; drift is the
        // full negative target per value_id. actual_amount stays empty.
        for (const valueId of Object.keys(target)) {
          driftAmount[valueId] = -targetAmount[valueId];
        }
        return _driftResult(0, {}, target, {}, ruleTargetAmount, targetAmount, actualAmount, driftAmount);
      }
      return { matching_total: 0, actual: {}, target, drift: {} };
    }

    // Sum across records WITH the target attribute (filtered total).
    const dist = calcDistribution(matching, targetCatId, recordsAttributes, fxRate);
    let filteredTotal = 0;
    for (const valueId of Object.keys(dist)) {
      if (valueId === '_unassigned') continue;
      filteredTotal += dist[valueId];
    }
    const unassignedTotal = matchingTotal - filteredTotal;

    const actual = {};
    const drift = {};

    if (filteredTotal === 0) {
      // Every matching record lacks the target attribute — there's nothing
      // to drift against the target distribution. Symmetric with the
      // matchingTotal === 0 branch above: drift_amount = -target_amount
      // per vid (informative; v1.17 ADR 0024 §4 edge case applies).
      actual._unassigned = 100;
      if (hasNetWorth) {
        for (const valueId of Object.keys(target)) {
          driftAmount[valueId] = -targetAmount[valueId];
        }
        return _driftResult(matchingTotal, actual, target, drift, ruleTargetAmount, targetAmount, actualAmount, driftAmount);
      }
      return { matching_total: matchingTotal, actual, target, drift };
    }

    // Normalize actual over filteredTotal so target-valueId percentages
    // sum to 100. _unassigned is reported separately as a pct of
    // matching_total (so the UI can show "X% of matching records weren't
    // categorized for this target").
    for (const valueId of Object.keys(target)) {
      const v = dist[valueId] || 0;
      actual[valueId] = (v / filteredTotal) * 100;
    }
    if (unassignedTotal > 0) {
      actual._unassigned = (unassignedTotal / matchingTotal) * 100;
    }

    for (const valueId of Object.keys(target)) {
      drift[valueId] = actual[valueId] - target[valueId];
    }

    if (hasNetWorth) {
      // v1.17 actual_amount: sum of records' TWD values per value_id (from
      // the same dist map that fed actual%). Debt records contribute
      // negatively because their value is negative. All distribute value_ids
      // are present (with 0 for those without records) so callers can index
      // by target_amount's keys without checking for undefined. The
      // _unassigned bucket has no target_amount (unassigned is not in
      // `distribute`), so drift_amount is only computed for distribute
      // value_ids.
      actualAmount = {};
      for (const valueId of Object.keys(target)) {
        actualAmount[valueId] = dist[valueId] || 0;
      }
      driftAmount = {};
      for (const valueId of Object.keys(target)) {
        const a = actualAmount[valueId] || 0;
        const t = targetAmount[valueId] || 0;
        driftAmount[valueId] = a - t;
      }
      return _driftResult(matchingTotal, actual, target, drift, ruleTargetAmount, targetAmount, actualAmount, driftAmount);
    }

    return { matching_total: matchingTotal, actual, target, drift };
  }

  // Build a drift result with the v1.17 amount fields included. Centralises
  // the 8-key shape so the four call sites don't have to spell it out.
  function _driftResult(matchingTotal, actual, target, drift, ruleTargetAmount, targetAmount, actualAmount, driftAmount) {
    return {
      matching_total: matchingTotal,
      actual,
      target,
      drift,
      rule_target_amount: ruleTargetAmount,
      target_amount: targetAmount,
      actual_amount: actualAmount,
      drift_amount: driftAmount,
    };
  }

  // Map driftForRule across a plan's rules. Empty / null plan → [].
  function driftForPlan(plan, records, recordsAttributes, fxRate, netWorth) {
    if (!_isPlainObject(plan) || !Array.isArray(plan.rules)) return [];
    return plan.rules.map(rule => driftForRule(rule, records, recordsAttributes, fxRate, netWorth));
  }

  // ---- Reference lookup (delete-protection) ----

  function plansReferencingCategory(categoryId, plans) {
    const planList = plans || [];
    const result = [];
    for (const plan of planList) {
      if (!_isPlainObject(plan) || !Array.isArray(plan.rules)) continue;
      const referenced = plan.rules.some(rule => {
        if (_isPlainObject(rule.when) && categoryId in rule.when) return true;
        if (_isPlainObject(rule.distribute) && categoryId in rule.distribute) return true;
        return false;
      });
      if (referenced) result.push(plan.id);
    }
    return result;
  }

  function plansReferencingValue(categoryId, valueId, plans) {
    const planList = plans || [];
    const result = [];
    for (const plan of planList) {
      if (!_isPlainObject(plan) || !Array.isArray(plan.rules)) continue;
      const referenced = plan.rules.some(rule => {
        if (_isPlainObject(rule.when)) {
          const vals = rule.when[categoryId];
          if (Array.isArray(vals) && vals.includes(valueId)) return true;
        }
        if (_isPlainObject(rule.distribute)) {
          const dist = rule.distribute[categoryId];
          if (_isPlainObject(dist) && valueId in dist) return true;
        }
        return false;
      });
      if (referenced) result.push(plan.id);
    }
    return result;
  }

  // ---- Public API ----

  const api = {
    newPlan,
    newRule,
    validateRule,
    validatePlan,
    validatePlans,
    recordsMatchingRule,
    calcDistribution,
    driftForRule,
    driftForPlan,
    plansReferencingCategory,
    plansReferencingValue,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html). Load order: lib/format.js → lib/plan.js
    // so the toTWD pull above resolves through root globals.
    root.Plan = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
