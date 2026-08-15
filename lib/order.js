// lib/order.js — Manual record ordering helpers (pure functions).
//
// Loaded by portfolio.html via <script src="lib/order.js"> (browser globals).
// Also imported by tests/order.test.js for Node.js testing (CommonJS).
//
// Source of truth for the v1.6 manual-ordering contract (ADR 0015):
//   - Storage shape: per-collection ID array (data.holdings_order[] /
//     data.cash_accounts_order[] / data.debts_order[]).
//   - Lazy-write: array absent until user first reorders; absence
//     means "fall back to insertion order."
//   - All helpers are pure: never mutate inputs. Callers assign the
//     returned array back onto this.data.<collection>_order.
//
// API:
//   applyOrder(records, ids)
//       → records reordered per `ids`. Defensive:
//           - null/undefined ids → shallow clone of records
//           - null/undefined records → []
//           - non-array ids → shallow clone of records
//           - non-string ids → dropped
//           - stale ids (not present in records) → dropped
//           - records whose id is not in ids → appended in original
//             relative order (handles records added after the order
//             array was materialized)
//   moveItem(ids, fromIndex, toIndex)
//       → new array with element at fromIndex moved to toIndex.
//         Out-of-range or equal indices → return original reference.
//   appendToOrder(order, id)
//       → new array with `id` appended. If id already present → return
//         original reference. null/undefined order → [id].
//   removeFromOrder(order, targetId)
//       → new array with targetId removed. If absent → return original
//         reference. null/undefined order → [].

(function (root) {
  'use strict';

  function applyOrder(records, ids) {
    if (!Array.isArray(records)) return [];
    if (!Array.isArray(ids)) return records.slice();

    const byId = new Map();
    for (const r of records) {
      if (r && typeof r.id === 'string') byId.set(r.id, r);
    }

    const ordered = [];
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      if (seen.has(id)) continue;
      const rec = byId.get(id);
      if (!rec) continue; // stale id (record was deleted)
      seen.add(id);
      ordered.push(rec);
    }

    // Append records whose id never appeared in `ids` (records added
    // after the order array was materialized). Original relative order
    // preserved because we walk `records` in order.
    for (const r of records) {
      if (r && !seen.has(r.id)) ordered.push(r);
    }

    return ordered;
  }

  function moveItem(ids, fromIndex, toIndex) {
    if (!Array.isArray(ids)) return ids;
    if (
      fromIndex < 0 || fromIndex >= ids.length ||
      toIndex < 0 || toIndex >= ids.length ||
      fromIndex === toIndex
    ) {
      return ids;
    }
    const out = ids.slice();
    const [moved] = out.splice(fromIndex, 1);
    out.splice(toIndex, 0, moved);
    return out;
  }

  function appendToOrder(order, id) {
    if (!Array.isArray(order)) return [id];
    if (order.indexOf(id) !== -1) return order; // already present → no-op
    return order.concat([id]);
  }

  function removeFromOrder(order, targetId) {
    if (!Array.isArray(order)) return [];
    const idx = order.indexOf(targetId);
    if (idx === -1) return order;
    return order.slice(0, idx).concat(order.slice(idx + 1));
  }

  const api = { applyOrder, moveItem, appendToOrder, removeFromOrder };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Order = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
