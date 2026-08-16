// tests/migration.test.js — tests for lib/migration.js (v1.7)
//
// Covers: migrateAdditiveFields(data, now) — ADR 0016 §2 load-time
// backfill. Pure, no I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Migration = require('../lib/migration.js');
const { migrateAdditiveFields } = Migration;

const FIXED_NOW = '2024-06-15T12:34:56.789Z';

// --- shape & robustness ---

test('migrateAdditiveFields: null input → null (no-op, no crash)', () => {
  assert.equal(migrateAdditiveFields(null, FIXED_NOW), null);
});

test('migrateAdditiveFields: undefined input → undefined (no-op)', () => {
  assert.equal(migrateAdditiveFields(undefined, FIXED_NOW), undefined);
});

test('migrateAdditiveFields: non-object input → returned as-is', () => {
  assert.equal(migrateAdditiveFields(42, FIXED_NOW), 42);
  assert.equal(migrateAdditiveFields('hi', FIXED_NOW), 'hi');
});

test('migrateAdditiveFields: empty object → empty object (idempotent)', () => {
  const out = migrateAdditiveFields({}, FIXED_NOW);
  assert.deepEqual(out, {});
});

// --- categories: updated_at backfill ---

test('migrateAdditiveFields: category missing updated_at → stamped with meta.created_at', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z', device_id: 'a' },
    categories: [{ id: 'finance', name: 'Finance' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].updated_at, '2024-01-01T00:00:00Z');
});

test('migrateAdditiveFields: category missing updated_at, meta.created_at also missing → falls back to now', () => {
  const data = {
    categories: [{ id: 'finance', name: 'Finance' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].updated_at, FIXED_NOW);
});

test('migrateAdditiveFields: category with existing updated_at → preserved untouched (idempotent)', () => {
  const existing = '2024-03-15T00:00:00Z';
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    categories: [{ id: 'finance', updated_at: existing }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].updated_at, existing, 'pre-existing updated_at must be preserved');
});

test('migrateAdditiveFields: each category in the array gets its own stamp (loop is per-record)', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    categories: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C', updated_at: '2024-02-15T00:00:00Z' },
    ],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].updated_at, '2024-01-01T00:00:00Z');
  assert.equal(data.categories[1].updated_at, '2024-01-01T00:00:00Z');
  assert.equal(data.categories[2].updated_at, '2024-02-15T00:00:00Z', 'idempotent: pre-existing preserved');
});

// --- categories: device_id backfill ---

test('migrateAdditiveFields: category missing device_id → stamped with meta.device_id', () => {
  const data = {
    meta: { device_id: 'this-device', created_at: '2024-01-01T00:00:00Z' },
    categories: [{ id: 'finance' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].device_id, 'this-device');
});

test('migrateAdditiveFields: category missing device_id, meta.device_id also missing → null', () => {
  const data = {
    categories: [{ id: 'finance' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].device_id, null, 'null when no meta.device_id — mirrors mergeById fallback');
});

test('migrateAdditiveFields: category with existing device_id → preserved untouched', () => {
  const data = {
    meta: { device_id: 'this-device' },
    categories: [{ id: 'finance', device_id: 'other-device' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].device_id, 'other-device', 'pre-existing device_id must be preserved');
});

// --- categories: invalid entries are skipped, not crashed ---

test('migrateAdditiveFields: null entry inside categories array → skipped (no crash)', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    categories: [null, { id: 'finance' }],
  };
  // Should not throw on the null entry.
  assert.doesNotThrow(() => migrateAdditiveFields(data, FIXED_NOW));
  assert.equal(data.categories[1].updated_at, '2024-01-01T00:00:00Z');
});

test('migrateAdditiveFields: non-object entry (string/number) inside categories → skipped', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    categories: ['not-an-object', 42, { id: 'finance' }],
  };
  assert.doesNotThrow(() => migrateAdditiveFields(data, FIXED_NOW));
  assert.equal(data.categories[2].updated_at, '2024-01-01T00:00:00Z');
});

// --- settings singleton: updated_at backfill ---

test('migrateAdditiveFields: settings missing updated_at → stamped with meta.created_at', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    settings: { fx_rate: 32.2, display_currency: 'TWD' },
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.settings.updated_at, '2024-01-01T00:00:00Z');
});

test('migrateAdditiveFields: settings missing updated_at, meta.created_at also missing → falls back to now', () => {
  const data = {
    settings: { fx_rate: 32.2 },
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.settings.updated_at, FIXED_NOW);
});

test('migrateAdditiveFields: settings with existing updated_at → preserved untouched (idempotent)', () => {
  const existing = '2024-03-15T00:00:00Z';
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z' },
    settings: { fx_rate: 32.2, updated_at: existing },
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.settings.updated_at, existing);
});

test('migrateAdditiveFields: settings missing entirely → no-op, no crash', () => {
  // Pre-v1.5 files (rare) lacked settings; nothing to migrate.
  const data = { meta: { created_at: '2024-01-01T00:00:00Z' } };
  assert.doesNotThrow(() => migrateAdditiveFields(data, FIXED_NOW));
  assert.equal(data.settings, undefined);
});

// --- combined: both categories + settings together ---

test('migrateAdditiveFields: pre-v1.7 portfolio (no updated_at anywhere) → both categories + settings backfilled in one pass', () => {
  // This is the user's bug scenario's prerequisite: a pre-v1.7 file
  // loaded into v1.7 must reach merge-eligible state in one pass.
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z', device_id: 'this' },
    settings: { fx_rate: 32.2, display_currency: 'TWD', language: 'zh' },
    categories: [
      { id: 'tech', name: 'Tech', applies_to: ['holdings'] },
      { id: 'finance', name: 'Finance', applies_to: ['holdings'] },
    ],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  assert.equal(data.categories[0].updated_at, '2024-01-01T00:00:00Z');
  assert.equal(data.categories[1].updated_at, '2024-01-01T00:00:00Z');
  assert.equal(data.categories[0].device_id, 'this');
  assert.equal(data.categories[1].device_id, 'this');
  assert.equal(data.settings.updated_at, '2024-01-01T00:00:00Z');
});

test('migrateAdditiveFields: idempotent — running twice produces the same result', () => {
  const data = {
    meta: { created_at: '2024-01-01T00:00:00Z', device_id: 'this' },
    settings: { fx_rate: 32.2 },
    categories: [{ id: 'finance' }],
  };
  migrateAdditiveFields(data, FIXED_NOW);
  const first = JSON.parse(JSON.stringify(data));
  migrateAdditiveFields(data, FIXED_NOW);
  assert.deepEqual(data, first, 'second pass is a no-op (no field overwritten)');
});

// --- default `now` parameter ---

test('migrateAdditiveFields: omitted `now` → uses current time (falls back to ISO now for missing fields)', () => {
  const before = Date.now();
  const data = {
    categories: [{ id: 'finance' }],
    settings: { fx_rate: 32.2 },
  };
  migrateAdditiveFields(data); // no `now`
  const after = Date.now();
  const catTs = new Date(data.categories[0].updated_at).getTime();
  const setTs = new Date(data.settings.updated_at).getTime();
  assert.ok(catTs >= before && catTs <= after, `category.updated_at ${catTs} in [${before}, ${after}]`);
  assert.ok(setTs >= before && setTs <= after, `settings.updated_at ${setTs} in [${before}, ${after}]`);
});
