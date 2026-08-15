// lib/sync.js — Portfolio sync conflict resolution (pure functions).
//
// Loaded by portfolio.html via <script src="lib/sync.js"> (browser globals).
// Also imported by tests/sync.test.js for Node.js testing (CommonJS).
//
// Source of truth for the merge rules:
//   * ADR 0004: per-record newer-wins by updated_at; tie → local.
//   * Spec issue 07: meta fields prefer local/remote explicitly per field;
//     categories / settings replaced from remote (v1 limitation, no per-field
//     timestamps on those — ADR 0009 §5).
//
// API:
//   mergeById(localArr, remoteArr)
//       → merged array. Each id: newer updated_at wins; tie → local;
//         missing updated_at treated as epoch 0; one-side-only pass-through.
//
//   mergePortfolios(local, remote, deviceId)
//       → full merged portfolio. Records use mergeById; categories / settings
//         replaced from remote (fall back to local); meta merged field-by-
//         field per spec; version prefers remote (fall back to local).
//       deviceId is the caller-resolved per-browser identifier, used as the
//       final fallback for meta.device_id. The lib does not generate this
//       value itself — the Alpine shim passes it.

(function (root) {
  'use strict';

  function tsOf(record) {
    // Records without updated_at (legacy v0.4 data, or newly-created records
    // before save() runs) are treated as epoch 0 — see ADR 0004.
    if (!record || !record.updated_at) return 0;
    const t = Date.parse(record.updated_at);
    return Number.isNaN(t) ? 0 : t;
  }

  function mergeById(localArr, remoteArr) {
    const map = new Map();
    for (const r of (localArr || [])) map.set(r.id, r);
    for (const r of (remoteArr || [])) {
      const l = map.get(r.id);
      if (!l) {
        map.set(r.id, r);
      } else if (tsOf(r) > tsOf(l)) {
        // Tie-break: local wins (== `tsOf(r) > tsOf(l)` strict inequality).
        map.set(r.id, r);
      }
      // else: local retained (tie or local newer).
    }
    return Array.from(map.values());
  }

  function mergeByIdWithDeletions(localArr, remoteArr, localDeletions, remoteDeletions) {
    // Compose mergeById with a deletion-log filter. A record whose id
    // appears in the merged deletion log is removed — "delete always
    // wins" over a stale edit on another device. See ADR 0011 (draft —
    // .scratch/v1.3-true-delete-with-backups/issues/04-adr-docs.md).
    const merged = mergeById(localArr, remoteArr);
    const mergedDeletions = mergeById(localDeletions || [], remoteDeletions || []);
    const deletedIds = new Set(mergedDeletions.map(d => d.target_id));
    return merged.filter(r => !deletedIds.has(r.id));
  }

  function mergePortfolios(local, remote, deviceId) {
    // Categories / settings lack per-field updated_at (ADR 0009 §5), so we
    // can't merge field-by-field. v1 limitation: replace-from-remote when
    // present, fall back to local.
    const settings = remote.settings || local.settings;
    const categories = remote.categories || local.categories;

    // active_plan_id (v1.4 — ticket 05): a scalar pointer with no
    // per-field timestamp. Use the same "prefer remote, fall back to
    // local" coarse-grained merge as meta.last_synced_at. An orphan
    // pointer (after the plan it references is deleted on another
    // device) survives merge by design — validatePlans() surfaces it
    // as a warning so the UI can offer "clear" or "restore", rather
    // than silently dropping user state.
    const activePlanId = remote.active_plan_id !== undefined
      ? remote.active_plan_id
      : (local.active_plan_id !== undefined ? local.active_plan_id : null);

    return {
      version: remote.version || local.version,
      meta: {
        device_id: local.meta?.device_id || remote.meta?.device_id || deviceId,
        last_synced_at: remote.meta?.last_synced_at || local.meta?.last_synced_at || null,
        created_at: local.meta?.created_at || remote.meta?.created_at || new Date().toISOString(),
      },
      settings,
      categories,
      holdings: mergeByIdWithDeletions(local.holdings, remote.holdings, local.deletions, remote.deletions),
      cash_accounts: mergeByIdWithDeletions(local.cash_accounts, remote.cash_accounts, local.deletions, remote.deletions),
      debts: mergeByIdWithDeletions(local.debts, remote.debts, local.deletions, remote.deletions),
      snapshots: mergeByIdWithDeletions(local.snapshots, remote.snapshots, local.deletions, remote.deletions),
      // data.plans[] (v1.4 — ticket 05): per-record merge by updated_at
      // (ADR 0004 pattern), tombstones from the existing deletion log
      // (ADR 0011). Pre-v1.4 portfolios missing the field are treated
      // as empty arrays.
      plans: mergeByIdWithDeletions(local.plans, remote.plans, local.deletions, remote.deletions),
      active_plan_id: activePlanId,
      // v1.6 — manual record ordering (ADR 0015). Three per-collection
      // ID arrays, prefer-remote like active_plan_id / settings: the
      // record-level `updated_at` doesn't track a UX preference, so we
      // use the coarse-grained "last-synced-wins" merge. Documented
      // limitation in ADR 0015 §4: when both devices reorder offline,
      // the earlier edit is silently overwritten.
      holdings_order: remote.holdings_order !== undefined
        ? remote.holdings_order
        : (local.holdings_order !== undefined ? local.holdings_order : undefined),
      cash_accounts_order: remote.cash_accounts_order !== undefined
        ? remote.cash_accounts_order
        : (local.cash_accounts_order !== undefined ? local.cash_accounts_order : undefined),
      debts_order: remote.debts_order !== undefined
        ? remote.debts_order
        : (local.debts_order !== undefined ? local.debts_order : undefined),
      deletions: mergeById(local.deletions, remote.deletions),
      backups: (() => {
        const merged = mergeById(local.backups, remote.backups);
        if (!merged || merged.length === 0) return merged;
        return merged
          .slice()
          .sort((a, b) => (Date.parse(a.saved_at) || 0) - (Date.parse(b.saved_at) || 0))
          .slice(-5);
      })(),
    };
  }

  const api = { mergeById, mergeByIdWithDeletions, mergePortfolios };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Sync = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);