// tests/backup.test.js — tests for lib/backup.js (v1.3)
//
// Source of truth: lib/backup.js + .scratch/v1.3-true-delete-with-backups/
//   issues/02-two-layer-backup-safety-net.md + spec.md §"Module: lib/backup.js".
//
// The library owns the two-layer backup push/pop/restore logic. Layer 1
// is pure (in-portfolio data.backups[]); Layer 2 wraps the Drive API
// with fetchFn injection so the tests are hermetic — same pattern as
// lib/refresh.js + tests/refresh.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- Slice 1: buildBackupSnapshot ----

test('buildBackupSnapshot: clones data; replaces data.backups with metadata; preserves data.deletions', () => {
  // The snapshot must be a deep clone (input array references must not
  // leak through) so the caller can mutate the snapshot without
  // affecting the live data. `data.backups` is replaced with metadata
  // because backing up the backups themselves would lead to a
  // recursive-expansion problem; `data.deletions` is preserved as-is
  // so a restore yields a self-consistent state (tombstones present
  // at backup-time are present in the snapshot).
  const Backup = require('../lib/backup.js');
  const data = {
    version: '1.1',
    holdings: [{ id: 'h1', shares: 10 }],
    cash_accounts: [],
    debts: [],
    deletions: [{ id: 'del-1', target_id: 'h0', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }],
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', data: { holdings: [] } },
    ],
  };

  const snapshot = Backup.buildBackupSnapshot(data);

  // Snapshot is a NEW object (not a reference to data).
  assert.notEqual(snapshot, data, 'snapshot must be a fresh object');
  // Holdings preserved.
  assert.deepEqual(snapshot.holdings, [{ id: 'h1', shares: 10 }]);
  // Deletions preserved as-is.
  assert.deepEqual(snapshot.deletions, data.deletions);
  // Backups replaced with metadata (count, oldest, newest).
  assert.equal(snapshot.backups.count, 3);
  assert.equal(snapshot.backups.oldest_saved_at, '2024-01-01T00:00:00Z');
  assert.equal(snapshot.backups.newest_saved_at, '2024-03-01T00:00:00Z');
  // Backups is NOT an array (it's metadata).
  assert.ok(!Array.isArray(snapshot.backups));
  assert.ok(!Array.isArray(snapshot.backups.oldest_saved_at));
});

test('buildBackupSnapshot: empty data.backups → metadata counts as 0 with null timestamps', () => {
  const Backup = require('../lib/backup.js');
  const data = { holdings: [], cash_accounts: [], debts: [], backups: [] };
  const snapshot = Backup.buildBackupSnapshot(data);
  assert.equal(snapshot.backups.count, 0);
  assert.equal(snapshot.backups.oldest_saved_at, null);
  assert.equal(snapshot.backups.newest_saved_at, null);
});

test('buildBackupSnapshot: undefined data.backups → treated as empty array', () => {
  const Backup = require('../lib/backup.js');
  const data = { holdings: [], cash_accounts: [], debts: [] };
  const snapshot = Backup.buildBackupSnapshot(data);
  assert.equal(snapshot.backups.count, 0);
  assert.equal(snapshot.backups.oldest_saved_at, null);
  assert.equal(snapshot.backups.newest_saved_at, null);
});

// ---- Slice 2: pushBackup ----

test('pushBackup: empty data.backups → 1 backup after push', () => {
  const Backup = require('../lib/backup.js');
  const data = { backups: [] };
  const snapshot = { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} };
  const ret = Backup.pushBackup(data, snapshot);
  assert.equal(data.backups.length, 1);
  assert.equal(data.backups[0].id, 'b1');
  assert.equal(ret, data, 'returns the (mutated) data');
});

test('pushBackup: 4 backups → push → 5 (no eviction)', () => {
  const Backup = require('../lib/backup.js');
  const data = {
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', data: {} },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', data: {} },
      { id: 'b4', saved_at: '2024-04-01T00:00:00Z', data: {} },
    ],
  };
  Backup.pushBackup(data, { id: 'b5', saved_at: '2024-05-01T00:00:00Z', data: {} });
  assert.equal(data.backups.length, 5);
  assert.deepEqual(data.backups.map(b => b.id), ['b1', 'b2', 'b3', 'b4', 'b5']);
});

test('pushBackup: 5 backups → push → 5 (oldest evicted)', () => {
  const Backup = require('../lib/backup.js');
  const data = {
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', data: {} },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', data: {} },
      { id: 'b4', saved_at: '2024-04-01T00:00:00Z', data: {} },
      { id: 'b5', saved_at: '2024-05-01T00:00:00Z', data: {} },
    ],
  };
  Backup.pushBackup(data, { id: 'b6', saved_at: '2024-06-01T00:00:00Z', data: {} });
  assert.equal(data.backups.length, 5);
  assert.deepEqual(data.backups.map(b => b.id), ['b2', 'b3', 'b4', 'b5', 'b6']);
});

test('pushBackup: out-of-order saved_at → sorted before slice', () => {
  // An incoming snapshot with an older saved_at must not break the
  // FIFO eviction; the array is sorted by saved_at ascending before
  // slicing the last 5.
  const Backup = require('../lib/backup.js');
  const data = {
    backups: [
      { id: 'b1', saved_at: '2024-02-01T00:00:00Z', data: {} },
      { id: 'b2', saved_at: '2024-03-01T00:00:00Z', data: {} },
      { id: 'b3', saved_at: '2024-04-01T00:00:00Z', data: {} },
      { id: 'b4', saved_at: '2024-05-01T00:00:00Z', data: {} },
      { id: 'b5', saved_at: '2024-06-01T00:00:00Z', data: {} },
    ],
  };
  Backup.pushBackup(data, { id: 'b_old', saved_at: '2024-01-01T00:00:00Z', data: {} });
  assert.equal(data.backups.length, 5);
  // With 6 entries after push, the oldest is b_old (2024-01-01), then b1-b5.
  // Last 5 are b1-b5 (b_old is the oldest and gets evicted).
  assert.deepEqual(data.backups.map(b => b.id), ['b1', 'b2', 'b3', 'b4', 'b5']);
});

test('pushBackup: custom maxKeep=3 → trims to 3', () => {
  const Backup = require('../lib/backup.js');
  const data = {
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', data: {} },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', data: {} },
    ],
  };
  Backup.pushBackup(data, { id: 'b4', saved_at: '2024-04-01T00:00:00Z', data: {} }, 3);
  assert.equal(data.backups.length, 3);
  assert.deepEqual(data.backups.map(b => b.id), ['b2', 'b3', 'b4']);
});

test('pushBackup: undefined data.backups → starts a fresh array', () => {
  const Backup = require('../lib/backup.js');
  const data = {};
  Backup.pushBackup(data, { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} });
  assert.equal(data.backups.length, 1);
  assert.equal(data.backups[0].id, 'b1');
});

// ---- Slice 3: restoreFromBackup ----

test('restoreFromBackup: returns {data, selfProtectionEntry} with backup content', () => {
  const Backup = require('../lib/backup.js');
  // Pre-restore state: 1 holding, 1 backup to restore from, 0 deletions.
  const backupEntry = {
    id: 'b1',
    saved_at: '2024-01-01T00:00:00Z',
    data: Backup.buildBackupSnapshot({
      holdings: [{ id: 'h1', shares: 5 }],
      cash_accounts: [],
      debts: [],
      backups: [],
      deletions: [{ id: 'del-1', target_id: 'h0', type: 'holdings', deleted_at: '2024-01-01T00:00:00Z', device_id: 'this' }],
    }),
  };
  const currentData = {
    holdings: [{ id: 'h1', shares: 10 }],
    backups: [backupEntry],
    deletions: [],
  };

  const result = Backup.restoreFromBackup(currentData, 'b1', {
    genId: (prefix) => `${prefix}-test-id`,
    now: () => '2024-06-15T00:00:00Z',
  });

  // Restored data has the backup's holdings.
  assert.equal(result.data.holdings.length, 1);
  assert.equal(result.data.holdings[0].shares, 5);
  // Restored data has the backup's deletions (per spec: 'the backup's
  // deletion log is what was true at backup-time').
  assert.equal(result.data.deletions.length, 1);
  assert.equal(result.data.deletions[0].id, 'del-1');
  // Backups now contains the self-protection entry (and possibly the
  // source backup sorted by saved_at).
  assert.ok(result.data.backups.length >= 1);
  // The self-protection entry is the latest by saved_at.
  const sp = result.data.backups.find(b => b.id === 'bp-test-id');
  assert.ok(sp, 'self-protection entry must be in the new backups array');
  // The self-protection entry IS the entry returned.
  assert.equal(result.selfProtectionEntry, sp);
  // The self-protection entry has saved_at from the injected `now`.
  assert.equal(result.selfProtectionEntry.saved_at, '2024-06-15T00:00:00Z');
  // The self-protection entry's `data` is a snapshot of the current state.
  assert.equal(result.selfProtectionEntry.data.holdings[0].shares, 10);
});

test('restoreFromBackup: also pushes the target backup itself into the new backups array (alongside self-protection)', () => {
  // The pre-restore state has 5 backups. After restore, the new backups
  // array should be: [self-protection entry] + [the existing 5 backups]
  // → FIFO 5 → the self-protection entry is kept, the oldest backup is
  // evicted. The target backup itself is NOT removed (the user is
  // viewing it as the most-recent; its entry is preserved so the user
  // can re-restore).
  const Backup = require('../lib/backup.js');
  const currentData = {
    holdings: [],
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b4', saved_at: '2024-04-01T00:00:00Z', data: { holdings: [] } },
      { id: 'b5', saved_at: '2024-05-01T00:00:00Z', data: { holdings: [] } },
    ],
    deletions: [],
  };
  const targetId = 'b3';

  const result = Backup.restoreFromBackup(currentData, targetId, {
    genId: (prefix) => `${prefix}-sp`,
    now: () => '2024-06-15T00:00:00Z',
  });

  assert.equal(result.data.backups.length, 5, 'FIFO 5 after restore');
  // The self-protection entry is the newest (latest saved_at).
  assert.equal(result.data.backups[result.data.backups.length - 1].id, 'bp-sp');
  // The oldest (b1) was evicted.
  assert.ok(!result.data.backups.some(b => b.id === 'b1'));
  // The target backup (b3) is still present.
  assert.ok(result.data.backups.some(b => b.id === 'b3'));
});

test('restoreFromBackup: unknown backupId → returns null', () => {
  const Backup = require('../lib/backup.js');
  const result = Backup.restoreFromBackup(
    { holdings: [], backups: [{ id: 'b1', saved_at: '2024-01-01T00:00:00Z', data: {} }], deletions: [] },
    'nonexistent',
    { genId: () => 'x', now: () => '2024-01-01T00:00:00Z' }
  );
  assert.equal(result, null);
});

test('restoreFromBackup: undefined data.backups → treated as empty', () => {
  const Backup = require('../lib/backup.js');
  const result = Backup.restoreFromBackup(
    { holdings: [{ id: 'h1', shares: 1 }] }, // no backups, no deletions
    'b1',
    { genId: () => 'x', now: () => '2024-01-01T00:00:00Z' }
  );
  // No backup matches → null.
  assert.equal(result, null);
});

test('restoreFromBackup: backup with missing fields in snapshot is restored as-is', () => {
  // The snapshot was built from a portfolio that had no fields like
  // cash_accounts. The restored data should still have those fields
  // missing (not synthesized). The only data.backups and data.deletions
  // are re-derived.
  const Backup = require('../lib/backup.js');
  const currentData = {
    holdings: [{ id: 'h1', shares: 99 }],
    backups: [{
      id: 'b1',
      saved_at: '2024-01-01T00:00:00Z',
      data: { holdings: [{ id: 'h1', shares: 1 }] }, // minimal snapshot
    }],
    deletions: [],
  };
  const result = Backup.restoreFromBackup(currentData, 'b1', {
    genId: () => 'sp',
    now: () => 'now',
  });
  assert.equal(result.data.holdings[0].shares, 1);
  // cash_accounts is not in the snapshot → not in the restored data.
  assert.equal(result.data.cash_accounts, undefined);
});

// ---- Slice 4: writePortfolioBackupFile (Layer 2 Drive write) ----

test('writePortfolioBackupFile: URL includes ?backup=1&device_id=...&ts=...', async () => {
  const Backup = require('../lib/backup.js');
  let captured = null;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ id: 'new-file-id', name: 'portfolio-backup-mydevice-2024-06-15T00:00:00Z.json' }) };
  };

  const res = await Backup.writePortfolioBackupFile('parent-file-id', '{"backups":[]}', {
    fetchFn,
    deviceId: 'mydevice',
    timestamp: '2024-06-15T00:00:00Z',
  });

  // URL has the expected query string.
  assert.match(captured.url, /[?&]backup=1/);
  assert.match(captured.url, /[?&]device_id=mydevice/);
  assert.match(captured.url, /[?&]ts=2024-06-15T00%3A00%3A00Z/);
  // Method is POST (per spec).
  assert.equal(captured.opts.method, 'POST');
  // Body is a multipart POST containing the content + filename metadata.
  assert.match(captured.opts.body, /\{"backups":\[\]\}/);
  assert.match(captured.opts.body, /portfolio-backup-mydevice-2024-06-15T00:00:00Z\.json/);
  // Returns the parsed response.
  assert.equal(res.id, 'new-file-id');
});

test('writePortfolioBackupFile: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.writePortfolioBackupFile('p', '{}', {
      deviceId: 'd',
      timestamp: '2024-01-01T00:00:00Z',
      // no fetchFn
    }),
    /fetchFn/,
  );
});

test('writePortfolioBackupFile: special characters in deviceId are URL-encoded', async () => {
  const Backup = require('../lib/backup.js');
  let captured = null;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({}) };
  };
  await Backup.writePortfolioBackupFile('p', '{}', {
    fetchFn,
    deviceId: 'device with spaces & special/chars',
    timestamp: '2024-01-01',
  });
  assert.ok(captured.url.includes('device_id=device%20with%20spaces%20%26%20special%2Fchars'),
    `URL must encode deviceId; got: ${captured.url}`);
});

// ---- Slice 5: listPortfolioBackupFiles ----

test('listPortfolioBackupFiles: queries Drive with name contains portfolio-backup- filter', async () => {
  const Backup = require('../lib/backup.js');
  let captured = null;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return {
      json: async () => ({
        files: [
          { id: 'a', name: 'portfolio-backup-d1-2024-01.json', modifiedTime: '2024-01-01T00:00:00Z' },
          { id: 'b', name: 'portfolio-backup-d2-2024-02.json', modifiedTime: '2024-02-01T00:00:00Z' },
        ],
      }),
    };
  };

  const out = await Backup.listPortfolioBackupFiles('parent-file-id', { fetchFn });

  // URL filters by `portfolio-backup-` and trashed=false.
  assert.match(captured.url, /[?&]q=/);
  assert.ok(captured.url.includes('portfolio-backup-'));
  assert.ok(captured.url.includes('trashed%3Dfalse') || captured.url.includes('trashed=false'));
  // Method is GET.
  assert.equal(captured.opts?.method, undefined, 'GET is the default; no method override expected');
  // Returns the files array.
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'a', name: 'portfolio-backup-d1-2024-01.json', modifiedTime: '2024-01-01T00:00:00Z' });
  assert.deepEqual(out[1], { id: 'b', name: 'portfolio-backup-d2-2024-02.json', modifiedTime: '2024-02-01T00:00:00Z' });
});

test('listPortfolioBackupFiles: empty Drive folder → returns []', async () => {
  const Backup = require('../lib/backup.js');
  const fetchFn = async () => ({ json: async () => ({ files: [] }) });
  const out = await Backup.listPortfolioBackupFiles('parent', { fetchFn });
  assert.deepEqual(out, []);
});

test('listPortfolioBackupFiles: missing files field → returns []', async () => {
  const Backup = require('../lib/backup.js');
  const fetchFn = async () => ({ json: async () => ({}) });
  const out = await Backup.listPortfolioBackupFiles('parent', { fetchFn });
  assert.deepEqual(out, []);
});

test('listPortfolioBackupFiles: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.listPortfolioBackupFiles('parent', {}),
    /fetchFn/,
  );
});

// ---- Slice 6: cleanupOldBackups ----

test('cleanupOldBackups: deletes oldest until count == keep - 1 (so the upcoming write makes it keep)', async () => {
  const Backup = require('../lib/backup.js');
  const deletes = [];
  const fetchFn = async (url, opts) => {
    // Mock list response (2 GETs to the list URL).
    if (url.includes('/drive/v3/files?') || (url.includes('drive/v3/files') && !opts?.method)) {
      return {
        json: async () => ({
          files: [
            { id: 'oldest', name: 'portfolio-backup-d-2024-01.json', modifiedTime: '2024-01-01T00:00:00Z' },
            { id: 'mid', name: 'portfolio-backup-d-2024-02.json', modifiedTime: '2024-02-01T00:00:00Z' },
            { id: 'newest', name: 'portfolio-backup-d-2024-03.json', modifiedTime: '2024-03-01T00:00:00Z' },
            { id: 'uno', name: 'portfolio-backup-d-2024-04.json', modifiedTime: '2024-04-01T00:00:00Z' },
          ],
        }),
      };
    }
    // DELETE call.
    if (opts?.method === 'DELETE') {
      const fileId = url.split('/').pop().split('?')[0];
      deletes.push(fileId);
      return { ok: true };
    }
    return { ok: true };
  };

  // keep=5; 4 existing + 1 upcoming = 5, so NO deletes.
  await Backup.cleanupOldBackups('parent', 5, { fetchFn });
  assert.equal(deletes.length, 0, 'with 4 existing + 1 upcoming = keep, no deletes');

  // keep=3; 4 existing + 1 upcoming = 5, should be 3, so delete 2 oldest.
  deletes.length = 0;
  await Backup.cleanupOldBackups('parent', 3, { fetchFn });
  assert.deepEqual(deletes, ['oldest', 'mid'], 'delete oldest until count == keep - 1');
});

test('cleanupOldBackups: default keep=5 → with 6 existing + 1 upcoming = 7, deletes 2 oldest', async () => {
  const Backup = require('../lib/backup.js');
  const deletes = [];
  const fetchFn = async (url, opts) => {
    if (opts?.method === 'DELETE') {
      const fileId = url.split('/').pop().split('?')[0];
      deletes.push(fileId);
      return { ok: true };
    }
    return {
      json: async () => ({
        files: [
          { id: 'f1', name: 'portfolio-backup-d-2024-01.json', modifiedTime: '2024-01-01T00:00:00Z' },
          { id: 'f2', name: 'portfolio-backup-d-2024-02.json', modifiedTime: '2024-02-01T00:00:00Z' },
          { id: 'f3', name: 'portfolio-backup-d-2024-03.json', modifiedTime: '2024-03-01T00:00:00Z' },
          { id: 'f4', name: 'portfolio-backup-d-2024-04.json', modifiedTime: '2024-04-01T00:00:00Z' },
          { id: 'f5', name: 'portfolio-backup-d-2024-05.json', modifiedTime: '2024-05-01T00:00:00Z' },
          { id: 'f6', name: 'portfolio-backup-d-2024-06.json', modifiedTime: '2024-06-01T00:00:00Z' },
        ],
      }),
    };
  };

  await Backup.cleanupOldBackups('parent', /* keep */ 5, { fetchFn });
  assert.equal(deletes.length, 2, '6 + 1 = 7, keep 5, delete 2 oldest');
  assert.deepEqual(deletes, ['f1', 'f2']);
});

test('cleanupOldBackups: with 0 existing files → no deletes', async () => {
  const Backup = require('../lib/backup.js');
  const deletes = [];
  const fetchFn = async (url, opts) => {
    if (opts?.method === 'DELETE') {
      deletes.push(url);
      return { ok: true };
    }
    return { json: async () => ({ files: [] }) };
  };
  await Backup.cleanupOldBackups('parent', 5, { fetchFn });
  assert.equal(deletes.length, 0);
});

test('cleanupOldBackups: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.cleanupOldBackups('parent', 5, {}),
    /fetchFn/,
  );
});
