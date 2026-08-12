// lib/records.js — Portfolio record helpers (pure functions).
//
// Loaded by portfolio.html via <script src="lib/records.js"> (browser globals).
// Also imported by tests/records.test.js for Node.js testing (CommonJS).
//
// Source of truth for the record-deletion contract:
//   * ADR 0011 (draft — .scratch/v1.3-true-delete-with-backups/issues/04-adr-docs.md)
//     documents the deletion-log + tombstone shape.
//   * The Alpine shim (portfolio.html removeHolding / removeCash /
//     removeDebt → _removeRecord) is a thin wrapper that calls this
//     and assigns the returned arrays back onto this.data. The lib
//     does not mutate inputs and does not read globals (deviceId /
//     genDelId / deletedAt are injected by the caller).
//
// API:
//   recordDeletion(records, deletions, { targetId, type, deviceId,
//                                      deletedAt, genDelId })
//       → { records, deletions, didDelete }
//         Removes the record whose id === targetId from `records` and
//         appends a tombstone
//           { id: genDelId(), target_id: targetId, type,
//             deleted_at: deletedAt, device_id: deviceId }
//         to `deletions`. Pure — never mutates inputs. If targetId is
//         not present in `records`, returns the original arrays
//         (same reference) and didDelete: false.

(function (root) {
  'use strict';

  function recordDeletion(records, deletions, opts) {
    const arr = records || [];
    const dels = deletions || [];
    const { targetId, type, deviceId, deletedAt, genDelId } = opts;
    const idx = arr.findIndex(r => r.id === targetId);
    if (idx === -1) {
      return { records: arr, deletions: dels, didDelete: false };
    }
    const remaining = arr.slice(0, idx).concat(arr.slice(idx + 1));
    const tombstone = {
      id: genDelId(),
      target_id: targetId,
      type,
      deleted_at: deletedAt,
      device_id: deviceId,
    };
    return {
      records: remaining,
      deletions: dels.concat([tombstone]),
      didDelete: true,
    };
  }

  const api = { recordDeletion };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Records = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);