// lib/migration.js — Portfolio data-file additive-field migration (pure functions).
//
// Loaded by portfolio.html via <script src="lib/migration.js"> (browser globals).
// Also imported by tests/migration.test.js for Node.js testing (CommonJS).
//
// Source of truth for v1.7's load-time backfill (ADR 0016 §2):
//   * Per-category: lazy-populate `updated_at` + `device_id` if missing.
//     Pre-v1.7 categories lacked both fields; mergeById treated them
//     as epoch 0, silently losing to any stamped remote. Backfill at
//     load time stamps `data.meta.created_at` (or `now`) for
//     `updated_at` and `data.meta.device_id` for `device_id`.
//   * Settings singleton: lazy-populate `updated_at` if missing.
//     Settings has no per-field timestamps — `updated_at` is the
//     whole-object merge signal (ADR 0016 §5).
//
// All migrations here are ADDITIVE (no schema version bump — ADR 0009
// §6). Already-present fields are preserved untouched.
//
// Pure — never mutates inputs deeper than the second level. Returns
// the same data reference passed in (matches project migration style:
// `parsed.forEach(c => { if (!c.X) c.X = ...; })` in portfolio.html's
// load() / handleImportFile()).

(function (root) {
  'use strict';

  function migrateAdditiveFields(data, now) {
    // Adapter: in browser `now` is not always injected; portfolio.html
    // passes `new Date().toISOString()`. Tests pass a fixed value for
    // determinism.
    const fallbackTs = now || new Date().toISOString();
    const fallbackDeviceId = null;

    if (!data || typeof data !== 'object') return data;

    // Categories — lazy-populate `updated_at` + `device_id`. Pre-v1.7
    // categories (ADR 0009 §5) lack both fields. After backfill, the
    // categories array is merge-eligible from the first sync forward.
    if (Array.isArray(data.categories)) {
      const metaTs = (data.meta && data.meta.created_at) || fallbackTs;
      const metaDev = (data.meta && data.meta.device_id) || fallbackDeviceId;
      data.categories.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (!c.updated_at) c.updated_at = metaTs;
        if (!c.device_id) c.device_id = metaDev;
      });
    }

    // Settings — lazy-populate `updated_at` on the singleton object.
    // Pre-v1.7 settings had no timestamp; v1.7 adds it (ADR 0016 §5).
    // No-op if settings is missing entirely (e.g. very old files
    // before settings was added) or already has `updated_at`.
    if (data.settings && typeof data.settings === 'object' && !data.settings.updated_at) {
      const metaTs = (data.meta && data.meta.created_at) || fallbackTs;
      data.settings.updated_at = metaTs;
    }

    return data;
  }

  const api = { migrateAdditiveFields };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Migration = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
