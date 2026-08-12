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
    // wins" over a stale edit on another device. See ADR 0011.
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