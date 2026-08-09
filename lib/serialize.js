// lib/serialize.js — Portfolio data serialization helpers.
//
// Strips in-memory-only fields before JSON.stringify so they never reach
// localStorage, Drive, or exported JSON files.
//
// Loaded by portfolio.html via <script src="lib/serialize.js"> (browser globals).
// Also imported by tests/serialize.test.js for Node.js testing (CommonJS).
//
// Architecture:
//   * Pure function, no DOM. Browser + Node.js compatible.
//   * In-memory fields: _refresh_failed (per ADR 0009 §4, transient UI feedback).
//   * Future in-memory fields (e.g. _last_snapshot_at) can be added to the same stripper.

(function (root) {
  'use strict';

  // Set of top-level holding fields that must never be persisted.
  // Extend this list when adding new transient UI state to holdings.
  const IN_MEMORY_HOLDING_FIELDS = new Set(['_refresh_failed']);

  function serializeData(data) {
    return JSON.stringify(data, (key, value) => {
      // Holding-level in-memory fields.
      if (IN_MEMORY_HOLDING_FIELDS.has(key)) return undefined;
      return value;
    }, 2);
  }

  // For tests / import paths: strip in-memory fields from a parsed object IN PLACE.
  // Mutates the input (and nested objects/arrays) so callers can do `stripInMemoryFields(arr)`
  // without reassigning. Returns the same reference for chaining convenience.
  function stripInMemoryFields(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) {
      data.forEach(stripInMemoryFields);
      return data;
    }
    for (const key of Object.keys(data)) {
      if (IN_MEMORY_HOLDING_FIELDS.has(key)) {
        delete data[key];
      } else if (typeof data[key] === 'object' && data[key] !== null) {
        stripInMemoryFields(data[key]);
      }
    }
    return data;
  }

  const api = { serializeData, stripInMemoryFields, IN_MEMORY_HOLDING_FIELDS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Serialize = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
