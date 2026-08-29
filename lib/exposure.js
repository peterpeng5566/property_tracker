// lib/exposure.js — pure exposure calculation helpers (v1.21).
//
// Loaded by portfolio.html via <script src="lib/exposure.js">
// (browser globals). Also imported by tests/exposure.test.js for
// Node.js testing (CommonJS). Mirrors the lib/calc.js / lib/plan.js /
// lib/group.js IIFE + module.exports pattern.
//
// Source of truth for:
//   - parseMultiplier              (string → number, permissive regex)
//   - ensureDefaultCategories      (load-time lazy-add, idempotent)
//   - findDefaultExposureCategory  (lookup helper for Alpine shim)
//   - exposureMultiplier           (Σ(v×m)/Σ(v), null when 0/0)
//   - exposureBreakdown            (per-bucket Bucket[] for the card subline)
//
// FX conversion delegated to lib/format.js toTWD so the conversion
// rule lives in one place. Inactive records excluded via the same
// `!record.inactive` filter as lib/calc.js sumInTWD.
//
// Default Exposure category shape (seeded by ensureDefaultCategories):
//   {
//     id: 'cat-default-exposure',
//     name: 'Exposure',
//     isDefault: true,
//     applies_to: ['holdings', 'cash'],
//     values: [
//       { id: 'val-default-0x', name: '0x' },
//       { id: 'val-default-1x', name: '1x' },
//       { id: 'val-default-2x', name: '2x' },
//     ],
//     updated_at: <ISO timestamp>,
//     device_id: <DEVICE_ID global or 'unknown'>,
//   }
//
// Spec: .scratch/v1.21-home-exposure-card/issues/01-lib-exposure-helpers.md.

(function (root) {
  'use strict';

  const { toTWD } = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./format.js')
    : { toTWD: root.toTWD };

  // Stable system id for the Default Exposure category. Surfaced via
  // the public api so attribute refs in the record stay readable.
  const DEFAULT_EXPOSURE_CATEGORY_ID = 'cat-default-exposure';

  // Seeded values — mirrors the `2x` style used elsewhere in the app.
  // Stable value ids (val-default-Nx) so attribute references survive
  // a sync round-trip unchanged.
  const DEFAULT_SEEDED_VALUES = ['0x', '1x', '2x'];

  // Permissive: accepts '2x', '1.5x', '0x', '2X' (case-insensitive),
  // optional 'x' suffix, surrounding whitespace tolerated. Anything
  // that doesn't match — empty / null / garbage / negative — returns 1.
  const MULTIPLIER_REGEX = /^(\d+(?:\.\d+)?)x?$/i;

  // Placeholder for the "_unassigned" bucket. Same approach as
  // lib/group.js UNASSIGNED_LABEL: the lib ships a locale-neutral
  // placeholder so tests can pin the contract without i18n state, and
  // the Alpine shim swaps in the localized string at render time.
  // The literal differs from lib/group.js ('— Unassigned') because the
  // exposure card subline already has its own bullet separator, so the
  // em-dash would be redundant noise.
  const UNASSIGNED_LABEL = 'Unassigned';

  // ---- parseMultiplier ----

  // String → non-negative number. Returns 1 for anything unparseable so
  // the lib never crashes on user-edited value names.
  function parseMultiplier(name) {
    if (typeof name !== 'string') return 1;
    const m = MULTIPLIER_REGEX.exec(name.trim());
    if (!m) return 1;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n < 0) return 1;
    return n;
  }

  // ---- private helpers ----

  // Identity check for the Default Exposure category. Centralised so
  // ensureDefaultCategories and findDefaultExposureCategory can't
  // drift apart (the id+isDefault pairing is the contract).
  function _isDefaultExposureCategory(c) {
    return !!(c && c.isDefault === true && c.id === DEFAULT_EXPOSURE_CATEGORY_ID);
  }

  function isActive(r) { return !r.inactive; }

  // ---- ensureDefaultCategories ----

  // Lazy-add the Default Exposure category. Idempotent — if the
  // Default Exposure category already exists (per _isDefaultExposureCategory),
  // returns the same data reference (no allocation). The id+isDefault
  // pairing prevents the function from accidentally treating a
  // user-created category with isDefault: true as the seed.
  function ensureDefaultCategories(data) {
    if (!data || !Array.isArray(data.categories)) return data;
    if (data.categories.some(_isDefaultExposureCategory)) return data;

    const now = new Date().toISOString();
    const deviceId = (typeof DEVICE_ID !== 'undefined') ? DEVICE_ID : 'unknown';
    const seeded = {
      id: DEFAULT_EXPOSURE_CATEGORY_ID,
      name: 'Exposure',
      isDefault: true,
      applies_to: ['holdings', 'cash'],
      values: DEFAULT_SEEDED_VALUES.map(name => ({
        id: `val-default-${name}`,
        name,
      })),
      updated_at: now,
      device_id: deviceId,
    };
    return {
      ...data,
      categories: [...data.categories, seeded],
    };
  }

  // ---- findDefaultExposureCategory ----

  // Convenience lookup for the Alpine shim. Returns the category object
  // or null. Defensive against malformed inputs (null, non-array, etc.)
  // so the shim can call it without guarding.
  function findDefaultExposureCategory(categories) {
    if (!Array.isArray(categories)) return null;
    return categories.find(_isDefaultExposureCategory) || null;
  }

  // ---- exposureBreakdown ----

  // Per-bucket breakdown of active holdings + cash, grouped by the value
  // they reference in `defaultExposureCategory`. Records with no
  // attribute (or whose attribute points at an unknown value id) land
  // in `_unassigned`. Buckets with count === 0 are dropped; the
  // `_unassigned` bucket is kept whenever it has records. Sort:
  // multiplier desc, then `_unassigned` last (mirrors lib/group.js).
  //
  // If defaultExposureCategory is null, returns [] — the Alpine shim
  // can treat that as "no card" and render `—` for the headline.
  function exposureBreakdown(holdings, cashAccounts, defaultExposureCategory, fxRate) {
    if (!defaultExposureCategory) return [];
    const catId = defaultExposureCategory.id;
    const values = defaultExposureCategory.values || [];

    const buckets = {};
    values.forEach(v => {
      buckets[v.id] = {
        valueId: v.id,
        valueName: v.name,
        multiplier: parseMultiplier(v.name),
        count: 0,
        totalTwd: 0,
      };
    });
    const unassigned = {
      valueId: '_unassigned',
      valueName: UNASSIGNED_LABEL,
      multiplier: 1,
      count: 0,
      totalTwd: 0,
    };

    function add(record, valueTwd) {
      const valueId = record.attributes && record.attributes[catId];
      const bucket = valueId ? buckets[valueId] : null;
      if (bucket) {
        bucket.count += 1;
        bucket.totalTwd += valueTwd;
      } else {
        unassigned.count += 1;
        unassigned.totalTwd += valueTwd;
      }
    }

    (holdings || []).filter(isActive).forEach(h => {
      add(h, toTWD(h.shares * h.current_price, h.currency, fxRate));
    });
    (cashAccounts || []).filter(isActive).forEach(c => {
      add(c, toTWD(c.balance, c.currency, fxRate));
    });

    const out = Object.values(buckets).filter(b => b.count > 0);
    if (unassigned.count > 0) out.push(unassigned);
    // Sort: highest multiplier first, `_unassigned` always last.
    // Tie-breaker on equal multiplier is stable per JS Array.prototype.sort
    // (since ES2019) so two buckets with the same multiplier keep their
    // declaration order in `cat.values` (e.g. user adds '3x' between
    // '2x' and '0x' → '3x' before '0x' for the same multiplier rank).
    out.sort((a, b) => {
      if (a.valueId === '_unassigned') return 1;
      if (b.valueId === '_unassigned') return -1;
      return b.multiplier - a.multiplier;
    });
    return out;
  }

  // ---- exposureMultiplier ----

  // Weighted-average multiplier across all active holdings + cash.
  // Returns null when there's no data (so the Alpine shim renders `—`).
  // 0/0 is intentionally null, not 0 — "no data" and "zero multiplier"
  // mean different things to the UI.
  function exposureMultiplier(holdings, cashAccounts, defaultExposureCategory, fxRate) {
    const breakdown = exposureBreakdown(holdings, cashAccounts, defaultExposureCategory, fxRate);
    if (breakdown.length === 0) return null;
    const totalTwd = breakdown.reduce((s, b) => s + b.totalTwd, 0);
    if (totalTwd === 0) return null; // safety; unreachable if breakdown is non-empty
    const weightedTwd = breakdown.reduce((s, b) => s + b.totalTwd * b.multiplier, 0);
    return weightedTwd / totalTwd;
  }

  const api = {
    parseMultiplier,
    ensureDefaultCategories,
    findDefaultExposureCategory,
    exposureMultiplier,
    exposureBreakdown,
    DEFAULT_EXPOSURE_CATEGORY_ID,
    UNASSIGNED_LABEL,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node.js (tests)
    module.exports = api;
  } else {
    // Browser (portfolio.html). Load order: lib/format.js → lib/exposure.js
    // so the toTWD pull above resolves through root globals.
    root.Exposure = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
