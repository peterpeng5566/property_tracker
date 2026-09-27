// tests/backup.test.js — tests for lib/backup.js (v1.23)
//
// Source of truth: lib/backup.js + docs/adr/0029-remove-layer1-backups.md
// (supersedes docs/adr/0012-backup-architecture.md in v1.23).
//
// v1.23 — Layer 1 (in-portfolio data.backups[]) is removed. The lib
// exposes only Layer 2 helpers (writePortfolioBackupFile /
// readPortfolioBackupFile / listPortfolioBackupFiles / cleanupOldBackups /
// parseBackupFilename / createCloudBackupsCache / buildMultipartBody) and
// the simplified restoreFromSnapshot. The Layer 1 pushBackup /
// buildBackupSnapshot / restoreFromBackup helpers are gone — no callers
// remain after the spec, so the tests that exercised them are also
// removed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- Slice 4: writePortfolioBackupFile (Layer 2 Drive write) ----

test('writePortfolioBackupFile: URL includes ?backup=1&device_id=...&ts=...', async () => {
  const Backup = require('../lib/backup.js');
  let captured = null;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ id: 'new-file-id', name: 'portfolio-backup-mydevice-2024-06-15T00:00:00Z.json' }) };
  };

  const res = await Backup.writePortfolioBackupFile('{"backups":[]}', {
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
    Backup.writePortfolioBackupFile('{}', {
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
  await Backup.writePortfolioBackupFile('{}', {
    fetchFn,
    deviceId: 'device with spaces & special/chars',
    timestamp: '2024-01-01',
  });
  assert.ok(captured.url.includes('device_id=device%20with%20spaces%20%26%20special%2Fchars'),
    `URL must encode deviceId; got: ${captured.url}`);
});

test('buildMultipartBody: produces the multipart/related shape used by Google Drive uploads', () => {
  const Backup = require('../lib/backup.js');
  const body = Backup.buildMultipartBody({
    meta: { name: 'foo.json', mimeType: 'application/json' },
    content: '{"x":1}',
    boundary: 'B',
  });
  // Structure: metadata part + content part + closing boundary.
  assert.match(body, /^--B\r\n/);
  assert.match(body, /Content-Type: application\/json; charset=UTF-8\r\n\r\n\{"name":"foo\.json","mimeType":"application\/json"\}\r\n/);
  assert.match(body, /--B\r\nContent-Type: application\/json\r\n\r\n\{"x":1\}\r\n/);
  assert.match(body, /--B--\r\n$/);
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

  const out = await Backup.listPortfolioBackupFiles({ fetchFn });

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
  const out = await Backup.listPortfolioBackupFiles({ fetchFn });
  assert.deepEqual(out, []);
});

test('listPortfolioBackupFiles: missing files field → returns []', async () => {
  const Backup = require('../lib/backup.js');
  const fetchFn = async () => ({ json: async () => ({}) });
  const out = await Backup.listPortfolioBackupFiles({ fetchFn });
  assert.deepEqual(out, []);
});

test('listPortfolioBackupFiles: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.listPortfolioBackupFiles({}),
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
  await Backup.cleanupOldBackups(5, { fetchFn });
  assert.equal(deletes.length, 0, 'with 4 existing + 1 upcoming = keep, no deletes');

  // keep=3; 4 existing + 1 upcoming = 5, should be 3, so delete 2 oldest.
  deletes.length = 0;
  await Backup.cleanupOldBackups(3, { fetchFn });
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

  await Backup.cleanupOldBackups(/* keep */ 5, { fetchFn });
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
  await Backup.cleanupOldBackups(5, { fetchFn });
  assert.equal(deletes.length, 0);
});

test('cleanupOldBackups: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.cleanupOldBackups(5, {}),
    /fetchFn/,
  );
});

// ---- Slice 7: readPortfolioBackupFile (Layer 2 Drive read for restore) ----

test('readPortfolioBackupFile: GETs the backup file content with ?backup=1 flag', async () => {
  const Backup = require('../lib/backup.js');
  let captured = null;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return {
      json: async () => ({ holdings: [{ id: 'h1', shares: 5 }] }),
    };
  };

  const out = await Backup.readPortfolioBackupFile('backup-file-id', { fetchFn });

  // URL pins the contract.
  assert.match(captured.url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/backup-file-id\?/);
  assert.match(captured.url, /[?&]alt=media/);
  assert.match(captured.url, /[?&]backup=1/);
  // Method is GET (default; no override).
  assert.equal(captured.opts?.method, undefined);
  // Returns the parsed JSON body.
  assert.deepEqual(out, { holdings: [{ id: 'h1', shares: 5 }] });
});

test('readPortfolioBackupFile: missing fetchFn → throws', async () => {
  const Backup = require('../lib/backup.js');
  await assert.rejects(
    Backup.readPortfolioBackupFile('parent', {}),
    /fetchFn/,
  );
});

// ---- Slice 8: restoreFromSnapshot (cloud-restore path; v1.23 simplified) ----
//
// v1.23 — the snapshot's holdings / cash_accounts / etc. flow through
// verbatim; the returned `data` always carries `backups: []` (the
// wire-format placeholder per ADR 0029 §1). The previous self-protection
// push + FIFO 5 logic is gone — undoing a restore means picking a
// different Layer 2 entry from the Drive list.

test('restoreFromSnapshot: applies the snapshot fields verbatim (no lookup, no self-protection)', () => {
  // The cloud-restore path fetches a backup file's content via
  // readPortfolioBackupFile, then calls restoreFromSnapshot to apply the
  // snapshot to data. v1.23 (ADR 0029): the snapshot's user-mutable
  // fields (holdings / cash / debts / categories / etc.) flow through
  // the spread; `backups` is hardcoded to `[]` (wire-format compat).
  // No self-protection entry, no FIFO trim — the input is replaced
  // wholesale by the snapshot's fields plus `backups: []`.
  const Backup = require('../lib/backup.js');
  const currentData = {
    holdings: [{ id: 'h-current', shares: 99 }],
    cash_accounts: [],
    debts: [],
    backups: [],
    deletions: [],
  };
  // Snapshot is the desired restore target (whatever shape the cloud
  // backup file happened to capture).
  const cloudSnapshot = {
    holdings: [{ id: 'h-from-cloud', shares: 5 }],
    cash_accounts: [],
    debts: [],
    backups: [],
    deletions: [],
  };

  const result = Backup.restoreFromSnapshot(currentData, cloudSnapshot);

  // Restored data has the cloud snapshot's holdings (snapshot wins).
  assert.deepEqual(result.data.holdings, [{ id: 'h-from-cloud', shares: 5 }]);
  // `backups` is hardcoded to `[]` — the wire-format placeholder per
  // ADR 0029 §1 (backward compat with older clients that read this
  // field). No self-protection entry, no FIFO trim.
  assert.deepEqual(result.data.backups, []);
  // Result shape: only `data`; no `selfProtectionEntry` field (the
  // property is gone in v1.23 — restore no longer pre-captures a
  // snapshot of the pre-restore state).
  assert.equal(result.selfProtectionEntry, undefined);
});

test('restoreFromSnapshot: cloud backup preserves its data.deletions', () => {
  // When restoring from a cloud snapshot, the snapshot's deletion log is
  // preserved (not the current state's). Per spec: "the backup's deletion
  // log is what was true at backup-time".
  const Backup = require('../lib/backup.js');
  const currentData = {
    holdings: [],
    cash_accounts: [],
    debts: [],
    backups: [],
    deletions: [
      { id: 'del-current', target_id: 'x', type: 'holdings', deleted_at: '2024-07-01T00:00:00Z', device_id: 'this' },
    ],
  };
  const cloudSnapshot = {
    holdings: [],
    backups: [],
    deletions: [
      { id: 'del-cloud', target_id: 'y', type: 'holdings', deleted_at: '2024-05-01T00:00:00Z', device_id: 'cloud' },
    ],
  };

  const result = Backup.restoreFromSnapshot(currentData, cloudSnapshot);

  // Restored deletions come from the cloud snapshot, not the current state.
  assert.equal(result.data.deletions.length, 1);
  assert.equal(result.data.deletions[0].id, 'del-cloud');
  // `backups` is hardcoded to `[]` regardless of inputs — there is
  // no longer a self-protection entry that could have captured the
  // current state's deletions.
  assert.deepEqual(result.data.backups, []);
  // No `selfProtectionEntry` property on the return value in v1.23.
  assert.equal(result.selfProtectionEntry, undefined);
});

// ---- Slice 9: parseBackupFilename (filename contract symmetric to encoder) ----
//
// parseBackupFilename is the decoder side of the filename format
// `portfolio-backup-{deviceId}-{timestamp}.json` that
// writePortfolioBackupFile encodes. Single source of truth: lib/backup.js.

test('parseBackupFilename: well-formed filename → {deviceId, timestamp}', () => {
  const Backup = require('../lib/backup.js');
  const result = Backup.parseBackupFilename('portfolio-backup-mydevice-2024-06-15T00:00:00.000Z.json');
  assert.deepEqual(result, {
    deviceId: 'mydevice',
    timestamp: '2024-06-15T00:00:00.000Z',
  });
});

test('parseBackupFilename: round-trip with writePortfolioBackupFile (single source of truth)', async () => {
  const Backup = require('../lib/backup.js');
  // The encoder's filename is parsed back into the same args.
  let capturedName = null;
  const fetchFn = async () => ({ json: async () => ({ id: 'x', name: capturedName }) });
  // Capture the filename by intercepting the multipart body.
  const capturingFetch = async (url, opts) => {
    const m = /"name":"([^"]+)"/.exec(opts.body);
    capturedName = m ? m[1] : null;
    return { json: async () => ({ id: 'x', name: capturedName }) };
  };
  await Backup.writePortfolioBackupFile('{}', {
    fetchFn: capturingFetch,
    deviceId: 'web-abc123',
    timestamp: '2024-06-15T12:34:56.789Z',
  });
  // The filename the encoder produced.
  assert.equal(capturedName, 'portfolio-backup-web-abc123-2024-06-15T12:34:56.789Z.json');
  // The decoder must recover the exact same deviceId + timestamp.
  const parsed = Backup.parseBackupFilename(capturedName);
  assert.deepEqual(parsed, {
    deviceId: 'web-abc123',
    timestamp: '2024-06-15T12:34:56.789Z',
  });
});

test('parseBackupFilename: deviceId with dashes is captured whole (greedy .+)', () => {
  const Backup = require('../lib/backup.js');
  // Greedy regex must consume dashes in deviceId, stopping only at the
  // last `-YYYY-MM-DDT` boundary.
  const result = Backup.parseBackupFilename('portfolio-backup-web-abc-123-2024-06-15T00:00:00Z.json');
  assert.deepEqual(result, {
    deviceId: 'web-abc-123',
    timestamp: '2024-06-15T00:00:00Z',
  });
});

test('parseBackupFilename: rejects malformed filenames → null', () => {
  const Backup = require('../lib/backup.js');
  // Wrong prefix
  assert.equal(Backup.parseBackupFilename('snapshot-mydevice-2024-06-15T00:00:00Z.json'), null);
  // Missing timestamp
  assert.equal(Backup.parseBackupFilename('portfolio-backup-mydevice.json'), null);
  // Wrong extension
  assert.equal(Backup.parseBackupFilename('portfolio-backup-mydevice-2024-06-15T00:00:00Z.txt'), null);
  // No extension
  assert.equal(Backup.parseBackupFilename('portfolio-backup-mydevice-2024-06-15T00:00:00Z'), null);
  // Empty deviceId would mean the regex matches nothing (`.+` requires ≥1 char)
  assert.equal(Backup.parseBackupFilename('portfolio-backup--2024-06-15T00:00:00Z.json'), null);
  // Garbage after the T prefix (not a real ISO 8601 timestamp)
  assert.equal(Backup.parseBackupFilename('portfolio-backup-mydevice-Tnotatimestamp.json'), null);
});

test('parseBackupFilename: non-string input → null', () => {
  const Backup = require('../lib/backup.js');
  assert.equal(Backup.parseBackupFilename(null), null);
  assert.equal(Backup.parseBackupFilename(undefined), null);
  assert.equal(Backup.parseBackupFilename(42), null);
  assert.equal(Backup.parseBackupFilename({ name: 'foo' }), null);
});

// ---- Slice 10: createCloudBackupsCache (cache state machine) ----
//
// The Alpine shim's fetchCloudBackups previously held the cache state
// inline (three reactive flags). The bug that motivated this slice:
// the no-token branch set `_cloudBackupsLoaded = true` without ever
// running a fetch — so the cache claimed "loaded" with empty data
// even though no Drive API call had run. Extracting the cache as a
// small state machine pins the invariant
//   loaded === true  ⇔  a fetch ran with a valid token
// in lib/ so the shim can't accidentally drift away from it.

test('createCloudBackupsCache: initial state → loaded=false, value=[], loading=false', () => {
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  assert.equal(cache.loaded, false);
  assert.deepEqual(cache.value, []);
  assert.equal(cache.loading, false);
});

test('createCloudBackupsCache: setLoaded(value) → loaded=true, value=value, loading=false', () => {
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  const files = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }];
  cache.setLoaded(files);
  assert.equal(cache.loaded, true);
  assert.deepEqual(cache.value, files);
  assert.equal(cache.loading, false);
});

test('createCloudBackupsCache: setLoaded([]) → loaded=true with empty value (fetched-zero is a valid result)', () => {
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  cache.setLoaded([]);
  assert.equal(cache.loaded, true);
  assert.deepEqual(cache.value, []);
});

test('createCloudBackupsCache: clear() before setLoaded → stays at default', () => {
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  cache.clear();
  assert.equal(cache.loaded, false);
  assert.deepEqual(cache.value, []);
  assert.equal(cache.loading, false);
});

test('createCloudBackupsCache: clear() AFTER setLoaded → loaded=false again (regression — cache can be reset after fetch)', () => {
  // This is the key invariant: clear() must drop `loaded`, so a
  // subsequent sign-in can re-fetch. Without this, the original
  // Backups-page stale-empty bug recurs (the shim would never be
  // able to invalidate the cache after sign-out / fetch error).
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  cache.setLoaded([{ id: 'a' }]);
  assert.equal(cache.loaded, true);
  cache.clear();
  assert.equal(cache.loaded, false);
  assert.deepEqual(cache.value, []);
});

test('createCloudBackupsCache: setLoading(true) does NOT mark loaded (regression — bug was marking loaded without fetch)', () => {
  // The original bug: setting loading=true was conflated with marking
  // loaded. The cache must keep `loaded=false` until setLoaded() runs
  // with a real value, otherwise the no-token branch (or any path that
  // sets loading without fetching) would shortcut future fetches.
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  cache.setLoading(true);
  assert.equal(cache.loaded, false);
  assert.equal(cache.loading, true);
  cache.setLoading(false);
  assert.equal(cache.loaded, false);
});

test('createCloudBackupsCache: clear() also resets loading (full reset)', () => {
  const Backup = require('../lib/backup.js');
  const cache = Backup.createCloudBackupsCache();
  cache.setLoading(true);
  cache.clear();
  assert.equal(cache.loading, false);
});