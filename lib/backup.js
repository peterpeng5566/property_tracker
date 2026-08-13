// lib/backup.js — Portfolio backup helpers (pure functions).
//
// Loaded by portfolio.html via <script src="lib/backup.js"> (browser globals).
// Also imported by tests/backup.test.js for Node.js testing (CommonJS).
//
// Source of truth: docs/adr/0012-backup-architecture.md (drafted in
// ticket #04) + .scratch/v1.3-true-delete-with-backups/spec.md §"Module: lib/backup.js".
//
// Two layers: Layer 1 (in-portfolio data.backups[]) is pure; Layer 2
// (Drive file) wraps Drive API calls with fetchFn injection so tests
// are hermetic — same pattern as lib/refresh.js.

(function (root) {
  'use strict';

  function buildBackupSnapshot(data) {
    const backups = Array.isArray(data.backups) ? data.backups : [];
    const sorted = backups.slice().sort((a, b) =>
      (Date.parse(a.saved_at) || 0) - (Date.parse(b.saved_at) || 0)
    );
    const oldest = sorted.length > 0 ? sorted[0].saved_at : null;
    const newest = sorted.length > 0 ? sorted[sorted.length - 1].saved_at : null;
    return {
      ...data,
      backups: {
        count: sorted.length,
        oldest_saved_at: oldest,
        newest_saved_at: newest,
      },
    };
  }

  function pushBackup(data, snapshot, maxKeep = 5) {
    const arr = Array.isArray(data.backups) ? data.backups.slice() : [];
    arr.push(snapshot);
    arr.sort((a, b) => (Date.parse(a.saved_at) || 0) - (Date.parse(b.saved_at) || 0));
    data.backups = arr.slice(-maxKeep);
    return data;
  }

  function restoreFromBackup(data, backupId, opts = {}) {
    const backups = Array.isArray(data.backups) ? data.backups : [];
    const target = backups.find(b => b.id === backupId);
    if (!target) return null;
    return restoreFromSnapshot(data, target.data || {}, opts);
  }

  // restoreFromSnapshot is the core restore algorithm shared by both the
  // local path (restoreFromBackup) and the cloud path (the Alpine shim
  // fetches the backup file's content via readPortfolioBackupFile, then
  // passes it directly). Same self-protection + FIFO 5 logic; the only
  // difference is that the snapshot is passed in instead of looked up.
  function restoreFromSnapshot(data, snapshot, opts = {}) {
    const genId = opts.genId || ((prefix) => prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const now = opts.now || (() => new Date().toISOString());
    const backups = Array.isArray(data.backups) ? data.backups : [];
    // snapshot is the target content (already-built snapshot). It may be
    // a partial shape (only the fields that existed when the snapshot
    // was made); the spread picks those up verbatim. `backups` and
    // `deletions` are re-derived below.
    const selfProtectionEntry = {
      id: genId('bp'),
      saved_at: now(),
      data: buildBackupSnapshot(data),
    };

    // Build the new backups array: pre-restore + self-protection, FIFO 5.
    const merged = backups.concat([selfProtectionEntry]);
    merged.sort((a, b) => (Date.parse(a.saved_at) || 0) - (Date.parse(b.saved_at) || 0));
    const newBackups = merged.slice(-5);

    return {
      data: {
        ...snapshot,
        backups: newBackups,
      },
      selfProtectionEntry,
    };
  }

  // Drive API endpoint for the backup file. The Drive write endpoint
  // for a new file (multipart POST) is the same shape as the
  // `createPortfolioFile` URL in portfolio.html; the `?backup=1`
  // flag is the lib's stable contract — the test pins it. The
  // `device_id` and `ts` query params encode the filename.
  function driveBackupUploadUrl(deviceId, timestamp) {
    return `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&backup=1&device_id=${encodeURIComponent(deviceId)}&ts=${encodeURIComponent(timestamp)}`;
  }

  // Build the body of a multipart/related POST for the Google Drive
  // upload endpoint. Used by both `writePortfolioBackupFile` (new
  // backup file) and `createPortfolioFile` in portfolio.html (new
  // portfolio file). Sharing the helper keeps the boundary / metadata
  // / content / closing-line shape in one place — if Google changes
  // the shape, both call sites move together.
  function buildMultipartBody({ meta, content, boundary }) {
    return (
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n` +
      `\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${content}\r\n` +
      `--${boundary}--\r\n`
    );
  }

  async function writePortfolioBackupFile(content, opts) {
    if (!opts || typeof opts.fetchFn !== 'function') {
      throw new Error('writePortfolioBackupFile: opts.fetchFn is required');
    }
    const { fetchFn, deviceId, timestamp } = opts;
    const filename = `portfolio-backup-${deviceId}-${timestamp}.json`;
    const boundary = 'pt_backup_boundary_' + Math.random().toString(36).slice(2);
    const meta = { name: filename, mimeType: 'application/json' };
    // Same multipart shape as `createPortfolioFile` in portfolio.html:
    // metadata first (name + mimeType), then content. The MIME boundary
    // is random so a single POST can carry both halves.
    const body = buildMultipartBody({ meta, content, boundary });
    const url = driveBackupUploadUrl(deviceId, timestamp);
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body,
    });
    if (res && typeof res.json === 'function') return await res.json();
    return res;
  }

  // Read a Layer 2 backup file's content. Used by the cloud-restore path
  // (ticket #03): the Alpine shim fetches the backup file via Drive API
  // using the file id from `listPortfolioBackupFiles`, then passes the
  // parsed JSON to `restoreFromSnapshot`. The `?backup=1` query flag is
  // the lib's stable URL contract (the test pins it).
  async function readPortfolioBackupFile(fileId, opts) {
    if (!opts || typeof opts.fetchFn !== 'function') {
      throw new Error('readPortfolioBackupFile: opts.fetchFn is required');
    }
    const { fetchFn } = opts;
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&backup=1`;
    const res = await fetchFn(url);
    if (res && typeof res.json === 'function') return await res.json();
    return res;
  }

  // List Drive files matching the Layer 2 backup filename pattern.
  // Account-wide scope (not folder-scoped) — see ADR 0012 §6
  // "single Drive folder per user" assumption.
  async function listPortfolioBackupFiles(opts) {
    if (!opts || typeof opts.fetchFn !== 'function') {
      throw new Error('listPortfolioBackupFiles: opts.fetchFn is required');
    }
    const { fetchFn } = opts;
    const q = "name contains 'portfolio-backup-' and trashed=false";
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`;
    const res = await fetchFn(url);
    const body = (res && typeof res.json === 'function') ? await res.json() : res;
    return Array.isArray(body?.files) ? body.files : [];
  }

  async function cleanupOldBackups(keep = 5, opts) {
    if (!opts || typeof opts.fetchFn !== 'function') {
      throw new Error('cleanupOldBackups: opts.fetchFn is required');
    }
    const { fetchFn } = opts;
    const files = await listPortfolioBackupFiles({ fetchFn });
    // Sort by modifiedTime ascending.
    const sorted = files.slice().sort((a, b) =>
      (Date.parse(a.modifiedTime) || 0) - (Date.parse(b.modifiedTime) || 0)
    );
    // The upcoming write will add 1, so we want sorted.length + 1 == keep,
    // i.e. sorted.length == keep - 1. Delete the oldest until we hit that.
    const targetLen = Math.max(0, keep - 1);
    const toDelete = sorted.slice(0, Math.max(0, sorted.length - targetLen));
    for (const f of toDelete) {
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`;
      await fetchFn(url, { method: 'DELETE' });
    }
    return { deleted: toDelete.map(f => f.id) };
  }

  const api = { buildBackupSnapshot, buildMultipartBody, pushBackup, restoreFromBackup, restoreFromSnapshot, writePortfolioBackupFile, readPortfolioBackupFile, listPortfolioBackupFiles, cleanupOldBackups };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Backup = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
