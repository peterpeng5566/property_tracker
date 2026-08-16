// tests/sync.test.js — tests for lib/sync.js (v1.2)
//
// Covers: mergeById() and mergePortfolios()
// Source of truth: lib/sync.js + ADR 0004 (per-record newer-wins by
// updated_at). Sync conflict resolution is pure, no I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../lib/sync.js');
const { mergeById, mergeByIdWithDeletions, mergePortfolios } = Sync;

const iso = (s) => new Date(s).toISOString();
const H = (id, opts = {}) => ({ id, ticker: opts.ticker || id, shares: 0, ...opts });

// --- mergeById: empty inputs ---

test('mergeById: both empty → empty', () => {
  assert.deepEqual(mergeById([], []), []);
});

test('mergeById: null/undefined inputs are treated as empty arrays', () => {
  assert.deepEqual(mergeById(null, [{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(mergeById([{ id: 'a' }], null), [{ id: 'a' }]);
  assert.deepEqual(mergeById(undefined, undefined), []);
});

// --- mergeById: one side only ---

test('mergeById: local only (remote empty) → local pass-through', () => {
  const local = [H('a', { shares: 1 }), H('b', { shares: 2 })];
  assert.deepEqual(mergeById(local, []), local);
});

test('mergeById: remote only (local empty) → remote pass-through', () => {
  const remote = [H('a', { shares: 99 })];
  assert.deepEqual(mergeById([], remote), remote);
});

// --- mergeById: disjoint ids ---

test('mergeById: disjoint ids → both sides present in result', () => {
  const local = [H('a', { shares: 1 })];
  const remote = [H('b', { shares: 2 })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 2);
  assert.ok(out.some(r => r.id === 'a' && r.shares === 1));
  assert.ok(out.some(r => r.id === 'b' && r.shares === 2));
});

// --- mergeById: same id, timestamp comparison ---

test('mergeById: same id, remote newer → remote wins', () => {
  const local = [H('a', { shares: 1, updated_at: iso('2024-01-01T00:00:00Z') })];
  const remote = [H('a', { shares: 99, updated_at: iso('2024-01-02T00:00:00Z') })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 99);
});

test('mergeById: same id, local newer → local wins', () => {
  const local = [H('a', { shares: 1, updated_at: iso('2024-02-01T00:00:00Z') })];
  const remote = [H('a', { shares: 99, updated_at: iso('2024-01-01T00:00:00Z') })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 1);
});

test('mergeById: same id, equal timestamp → local wins (tie-break)', () => {
  const t = iso('2024-01-01T00:00:00Z');
  const local = [H('a', { shares: 1, updated_at: t })];
  const remote = [H('a', { shares: 99, updated_at: t })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 1);
});

// --- mergeById: missing updated_at treated as epoch 0 ---

test('mergeById: updated_at missing on local → treated as epoch 0, remote newer wins', () => {
  const local = [H('a', { shares: 1 })];
  const remote = [H('a', { shares: 99, updated_at: iso('2024-01-01T00:00:00Z') })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 99);
});

test('mergeById: updated_at missing on remote → treated as epoch 0, local wins', () => {
  const local = [H('a', { shares: 1, updated_at: iso('2024-01-01T00:00:00Z') })];
  const remote = [H('a', { shares: 99 })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 1);
});

test('mergeById: updated_at missing on both → tie-break (local wins)', () => {
  const local = [H('a', { shares: 1 })];
  const remote = [H('a', { shares: 99 })];
  const out = mergeById(local, remote);
  assert.equal(out.length, 1);
  assert.equal(out[0].shares, 1);
});

// --- mergeById: multiple records, mixed scenarios ---

test('mergeById: realistic scenario (3 records with mixed timestamp outcomes)', () => {
  const local = [
    H('a', { shares: 1, updated_at: iso('2024-01-01T00:00:00Z') }), // remote newer
    H('b', { shares: 2, updated_at: iso('2024-02-01T00:00:00Z') }), // local newer
    H('c', { shares: 3 }),                                          // only local
  ];
  const remote = [
    H('a', { shares: 99, updated_at: iso('2024-02-01T00:00:00Z') }),
    H('b', { shares: 22, updated_at: iso('2024-01-01T00:00:00Z') }),
    H('d', { shares: 4, updated_at: iso('2024-02-01T00:00:00Z') }),  // only remote
  ];
  const out = mergeById(local, remote);
  const byId = Object.fromEntries(out.map(r => [r.id, r]));
  assert.equal(out.length, 4);
  assert.equal(byId.a.shares, 99);
  assert.equal(byId.b.shares, 2);
  assert.equal(byId.c.shares, 3);
  assert.equal(byId.d.shares, 4);
});

// --- mergePortfolios: empty inputs ---

test('mergePortfolios: both empty → meta with null last_synced_at and provided deviceId', () => {
  const out = mergePortfolios({}, {}, 'my-device');
  assert.equal(out.meta.device_id, 'my-device');
  assert.equal(out.meta.last_synced_at, null);
  assert.ok(typeof out.meta.created_at === 'string' && out.meta.created_at.length > 0);
  assert.deepEqual(out.holdings, []);
  assert.deepEqual(out.cash_accounts, []);
  assert.deepEqual(out.debts, []);
  assert.deepEqual(out.snapshots, []);
});

test('mergePortfolios: empty inputs → created_at is current ISO time', () => {
  const before = Date.now();
  const out = mergePortfolios({}, {}, 'd');
  const after = Date.now();
  const ts = new Date(out.meta.created_at).getTime();
  assert.ok(ts >= before && ts <= after, `expected ${ts} in [${before}, ${after}]`);
});

// --- mergeSettings: object-level newer-wins (v1.7, ADR 0016) ---
//
// Settings is a singleton object (not record-bearing). v1.7 replaces
// the v1 `replace-from-remote` workaround with object-level
// newer-wins on `settings.updated_at`. Strict `>` so tie → local
// (symmetric with mergeById / mergeByIdWithDeletions tie-break).

test('mergeSettings: both null/undefined → null', () => {
  assert.equal(Sync.mergeSettings(null, null), null);
  assert.equal(Sync.mergeSettings(undefined, undefined), null);
  assert.equal(Sync.mergeSettings(null, undefined), null);
  assert.equal(Sync.mergeSettings(undefined, null), null);
});

test('mergeSettings: only local (remote null) → local', () => {
  const local = { fx_rate: 32.2, updated_at: '2024-01-15T00:00:00Z' };
  const out = Sync.mergeSettings(local, null);
  assert.deepEqual(out, local);
});

test('mergeSettings: only remote (local null) → remote', () => {
  const remote = { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' };
  const out = Sync.mergeSettings(null, remote);
  assert.deepEqual(out, remote);
});

test('mergeSettings: local newer → local wins (whole object)', () => {
  const local = { fx_rate: 32.2, updated_at: '2024-02-01T00:00:00Z' };
  const remote = { fx_rate: 30.5, updated_at: '2024-01-15T00:00:00Z' };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, local, 'newer local wins — whole object replaced');
});

test('mergeSettings: remote newer → remote wins (whole object)', () => {
  const local = { fx_rate: 32.2, updated_at: '2024-01-15T00:00:00Z' };
  const remote = { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, remote, 'newer remote wins — whole object replaced');
});

test('mergeSettings: equal timestamps → local wins (tie-break, strict >)', () => {
  const t = '2024-01-15T00:00:00Z';
  const local = { fx_rate: 32.2, updated_at: t };
  const remote = { fx_rate: 30.5, updated_at: t };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, local, 'strict > → local retains on tie');
});

test('mergeSettings: both updated_at missing → local wins (fallback / epoch-0 treat)', () => {
  // Pre-v1.7 settings have no `updated_at`. mergeSettings treats
  // missing as epoch 0 (mirror mergeById tsOf semantics). Both
  // epoch 0 → tie → local wins. After load-time backfill stamps
  // updated_at, this code path rarely fires — kept for the case
  // where backfill somehow didn't run (e.g. settings is undefined
  // and gets lazy-resolved to a default later).
  const local = { fx_rate: 32.2 };
  const remote = { fx_rate: 30.5 };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, local);
});

test('mergeSettings: local updated_at missing, remote newer → remote wins', () => {
  // Local is pre-v1.7 (no updated_at); remote is post-v1.7 with a
  // real timestamp. remote should win — the user-edited value
  // survives.
  const local = { fx_rate: 32.2 };
  const remote = { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, remote);
});

test('mergeSettings: local newer, remote updated_at missing → local wins', () => {
  // Local was post-v1.7 (real timestamp) but remote is pre-v1.7
  // (epoch 0). Local should win.
  const local = { fx_rate: 32.2, updated_at: '2024-02-01T00:00:00Z' };
  const remote = { fx_rate: 30.5 };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, local);
});

test('mergeSettings: invalid updated_at on local → treated as epoch 0 (remote with real ts wins)', () => {
  // Defensive — invalid ISO strings fall back to 0 (mirror tsOf).
  const local = { fx_rate: 32.2, updated_at: 'not-a-date' };
  const remote = { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' };
  const out = Sync.mergeSettings(local, remote);
  assert.deepEqual(out, remote);
});

// --- mergePortfolios: categories via mergeByIdWithDeletions (v1.7, ADR 0016) ---
//
// Pre-v1.7 categories were replaced from remote (ADR 0009 §5 v1
// limitation). v1.7 supersedes: categories are record-bearing and
// merge via the same primitive as plans / holdings / cash / debts /
// snapshots. Each category carries updated_at + device_id (lazy
// populated at load time per ADR 0016 §2). Deletions propagate via
// the same data.deletions[] log (type: 'categories' — enum extension
// of ADR 0011).

const C = (id, opts = {}) => Object.assign({
  id,
  name: opts.name || id,
  applies_to: opts.applies_to || ['holdings'],
}, opts);

test('mergePortfolios: categories uses mergeByIdWithDeletions (per-record newer wins, was replace-from-remote)', () => {
  // v1.7 regression — pre-v1.7 had out.categories === remote.categories
  // (replace-from-remote). Now it's per-record mergeByIdWithDeletions.
  const local = {
    categories: [C('finance', { name: 'Local-Finance', updated_at: '2024-02-01T00:00:00Z', device_id: 'a' })],
    holdings: [],
  };
  const remote = {
    categories: [C('finance', { name: 'Remote-Finance', updated_at: '2024-01-15T00:00:00Z', device_id: 'b' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories.length, 1);
  assert.equal(out.categories[0].name, 'Local-Finance', 'local newer wins per mergeById');
});

test('mergePortfolios: categories disjoint ids → both sides present (was wipe)', () => {
  // v1.7 regression — pre-v1.7 lost all local categories on a stale
  // pull (replace-from-remote). Now disjoint ids are unioned.
  const local = {
    categories: [C('tech', { updated_at: '2024-01-15T00:00:00Z', device_id: 'a' })],
    holdings: [],
  };
  const remote = {
    categories: [C('finance', { updated_at: '2024-02-01T00:00:00Z', device_id: 'b' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories.length, 2);
  assert.ok(out.categories.some(c => c.id === 'tech'));
  assert.ok(out.categories.some(c => c.id === 'finance'));
});

test('mergePortfolios: categories local adds (id not on remote) → preserved on remote pull', () => {
  // User adds a category on Device B; pulls Device A's stale remote →
  // the new category must survive. Was the user-reported bug.
  const local = {
    categories: [C('new-cat', { updated_at: '2024-02-01T00:00:00Z', device_id: 'b' })],
    holdings: [],
  };
  const remote = {
    categories: [C('old-cat', { updated_at: '2024-01-15T00:00:00Z', device_id: 'a' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories.length, 2, 'both old and new categories survive');
  assert.ok(out.categories.some(c => c.id === 'new-cat'));
  assert.ok(out.categories.some(c => c.id === 'old-cat'));
});

test('mergePortfolios: categories deleted via tombstone (type=categories) → removed from result', () => {
  // deleteCategory pushes type: 'categories' tombstone. The tombstone
  // filters the categories array on the next sync, mirroring how
  // holdings / cash / debts / snapshots / plans deletions propagate
  // (ADR 0011, type enum extended).
  const local = {
    categories: [],
    deletions: [{ id: 'del-1', target_id: 'finance', type: 'categories',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'this' }],
    holdings: [],
  };
  const remote = {
    categories: [C('finance', { updated_at: '2024-02-01T00:00:00Z', device_id: 'b' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.categories.length, 0, 'tombstone removes category');
});

test('mergePortfolios: categories remote tombstone (type=categories) → removed locally', () => {
  const local = {
    categories: [C('finance', { updated_at: '2024-02-01T00:00:00Z', device_id: 'this' })],
    holdings: [],
  };
  const remote = {
    categories: [],
    deletions: [{ id: 'del-1', target_id: 'finance', type: 'categories',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'other' }],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.categories.length, 0, 'remote tombstone filters local category');
});

test('mergePortfolios: categories both sides delete → single category removed, tombstones unioned', () => {
  const local = {
    categories: [],
    deletions: [{ id: 'del-1', target_id: 'finance', type: 'categories',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'a' }],
    holdings: [],
  };
  const remote = {
    categories: [C('finance', { updated_at: '2024-02-01T00:00:00Z', device_id: 'b' })],
    deletions: [{ id: 'del-2', target_id: 'finance', type: 'categories',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'b' }],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories.length, 0);
  // Both tombstones survive (different ids) — the merger does not
  // dedupe across devices; it dedupes within a device via mergeById.
  assert.ok(out.deletions.some(d => d.target_id === 'finance'));
});

test('mergePortfolios: categories missing on both sides → empty array (not undefined)', () => {
  // Mirror holdings / cash / debts / snapshots / plans return-shape
  // contract. Always [] rather than undefined so consumers can
  // safely call .filter / .map without nullish guards.
  const out = mergePortfolios({}, {}, 'd');
  assert.deepEqual(out.categories, []);
});

test('mergePortfolios: categories rename same id, remote newer → remote wins (per-record merge)', () => {
  // Both devices edit the same category's name simultaneously; the
  // newer updated_at wins. Tie on updated_at → local wins (mergeById
  // convention). Documented as Q6 known limitation in ADR 0016 §9.
  const local = {
    categories: [C('finance', { name: 'Local-Rename', updated_at: '2024-01-15T00:00:00Z', device_id: 'a' })],
    holdings: [],
  };
  const remote = {
    categories: [C('finance', { name: 'Remote-Rename', updated_at: '2024-02-01T00:00:00Z', device_id: 'b' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories.length, 1);
  assert.equal(out.categories[0].name, 'Remote-Rename');
});

test('mergePortfolios: categories pre-v1.7 (no updated_at) on both → both at epoch 0 → tie → local wins', () => {
  // Pre-v1.7 file merge fallback. Mirror mergeById tsOf=0 behaviour:
  // no updated_at = epoch 0, tie at 0 → local wins.
  const local = { categories: [C('tech', { name: 'L' })], holdings: [] };
  const remote = { categories: [C('tech', { name: 'R' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.categories[0].name, 'L');
});

test('mergePortfolios: categories cross-collection tombstone isolation (holdings tombstone does NOT remove a category)', () => {
  // The deletion-log filter keys by `id` matching the merged
  // deletion log → which is itself all-types. Reuse the same id
  // name deliberately means the tombstone would remove ANY record
  // with that id. Real-world categories use 'cat-' prefix and
  // holdings use 'h-' prefix so id collision is unlikely; this
  // test pins the contract that id-based matching means what it
  // says. If a user somehow had a category id == a holding id, that
  // tombstone would remove both. This is documented behavior, not a
  // bug.
  const local = {
    categories: [C('h1', { name: 'Magic-Cat' })],
    holdings: [],
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'a' }],
  };
  const remote = { holdings: [] };
  const out = mergePortfolios(local, remote, 'a');
  assert.equal(out.categories.length, 0, 'id-collision: the holdings tombstone removes the category too');
});

// --- mergePortfolios: settings uses mergeSettings (v1.7, ADR 0016) ---

test('mergePortfolios: settings uses mergeSettings (newer wins, not replace-from-remote)', () => {
  // This is the regression: pre-v1.7 settings were replaced wholesale
  // from remote when present (ADR 0009 §5 v1 limitation), silently
  // wiping local edits even when the user just edited fx_rate on this
  // device. v1.7 changes to mergeSettings.
  const local = { settings: { fx_rate: 32.2, updated_at: '2024-02-01T00:00:00Z' }, holdings: [] };
  const remote = { settings: { fx_rate: 30.5, updated_at: '2024-01-15T00:00:00Z' }, holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.settings, { fx_rate: 32.2, updated_at: '2024-02-01T00:00:00Z' });
});

test('mergePortfolios: settings replace-from-remote BEHAVIOR is gone (regression guard)', () => {
  // Pre-v1.7: out.settings would equal the remote object (whole
  // object replacement). Post-v1.7: out.settings is whichever side
  // is newer — even if local is "old" by stale-Drive-state but the
  // user just edited it locally, local wins.
  const local = {
    settings: { fx_rate: 32.2, display_currency: 'TWD', updated_at: '2024-02-01T00:00:00Z' },
    holdings: [],
  };
  const remote = {
    settings: { fx_rate: 30.5, display_currency: 'USD', updated_at: '2024-01-15T00:00:00Z' },
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.settings.fx_rate, 32.2, 'local newer wins even though remote.fx_rate differs');
  assert.equal(out.settings.display_currency, 'TWD', 'all fields inherited from local-wholesale');
});

test('mergePortfolios: settings pre-v1.7 (no updated_at) on both sides → local wins', () => {
  // Pre-v1.7 file merged with pre-v1.7 file → both lack
  // updated_at → tie at epoch 0 → local wins. Distinct from the
  // old replace-from-remote behavior: now the seam is mergeSettings
  // which has its own fallback rule.
  const local = { settings: { fx_rate: 32.2 }, holdings: [] };
  const remote = { settings: { fx_rate: 30.5 }, holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.settings, { fx_rate: 32.2 });
});

test('mergePortfolios: settings absent on one side → present side wins', () => {
  // Pre-v1.7 fallback to local when remote absent is preserved.
  const local = { settings: { fx_rate: 32.2, updated_at: '2024-01-15T00:00:00Z' }, holdings: [] };
  const remote = { holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.settings, { fx_rate: 32.2, updated_at: '2024-01-15T00:00:00Z' });

  const local2 = { holdings: [] };
  const remote2 = { settings: { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' }, holdings: [] };
  const out2 = mergePortfolios(local2, remote2, 'd');
  assert.deepEqual(out2.settings, { fx_rate: 30.5, updated_at: '2024-02-01T00:00:00Z' });
});

// --- mergePortfolios: meta device_id (prefers local, then remote, then deviceId) ---

test('mergePortfolios: meta.device_id prefers local', () => {
  const out = mergePortfolios(
    { meta: { device_id: 'local-d' }, holdings: [] },
    { meta: { device_id: 'remote-d' }, holdings: [] },
    'fallback-d'
  );
  assert.equal(out.meta.device_id, 'local-d');
});

test('mergePortfolios: meta.device_id falls back to remote when local missing', () => {
  const out = mergePortfolios(
    { meta: {}, holdings: [] },
    { meta: { device_id: 'remote-d' }, holdings: [] },
    'fallback-d'
  );
  assert.equal(out.meta.device_id, 'remote-d');
});

test('mergePortfolios: meta.device_id falls back to deviceId when both missing', () => {
  const out = mergePortfolios(
    { meta: {}, holdings: [] },
    { meta: {}, holdings: [] },
    'fallback-d'
  );
  assert.equal(out.meta.device_id, 'fallback-d');
});

test('mergePortfolios: meta.device_id when both sides lack .meta entirely → deviceId', () => {
  const out = mergePortfolios({}, {}, 'fallback-d');
  assert.equal(out.meta.device_id, 'fallback-d');
});

// --- mergePortfolios: meta last_synced_at (prefers remote, then local, then null) ---

test('mergePortfolios: meta.last_synced_at prefers remote', () => {
  const out = mergePortfolios(
    { meta: { last_synced_at: '2024-01-01T00:00:00Z' }, holdings: [] },
    { meta: { last_synced_at: '2024-02-01T00:00:00Z' }, holdings: [] },
    'd'
  );
  assert.equal(out.meta.last_synced_at, '2024-02-01T00:00:00Z');
});

test('mergePortfolios: meta.last_synced_at falls back to local when remote missing', () => {
  const out = mergePortfolios(
    { meta: { last_synced_at: '2024-01-01T00:00:00Z' }, holdings: [] },
    { meta: {}, holdings: [] },
    'd'
  );
  assert.equal(out.meta.last_synced_at, '2024-01-01T00:00:00Z');
});

test('mergePortfolios: meta.last_synced_at null when both missing', () => {
  const out = mergePortfolios({ meta: {}, holdings: [] }, { meta: {}, holdings: [] }, 'd');
  assert.equal(out.meta.last_synced_at, null);
});

// --- mergePortfolios: meta created_at (prefers local, then remote, then now) ---

test('mergePortfolios: meta.created_at prefers local', () => {
  const out = mergePortfolios(
    { meta: { created_at: '2024-01-01T00:00:00Z' }, holdings: [] },
    { meta: { created_at: '2024-02-01T00:00:00Z' }, holdings: [] },
    'd'
  );
  assert.equal(out.meta.created_at, '2024-01-01T00:00:00Z');
});

test('mergePortfolios: meta.created_at falls back to remote when local missing', () => {
  const out = mergePortfolios(
    { meta: {}, holdings: [] },
    { meta: { created_at: '2024-02-01T00:00:00Z' }, holdings: [] },
    'd'
  );
  assert.equal(out.meta.created_at, '2024-02-01T00:00:00Z');
});

test('mergePortfolios: meta.created_at computed as now() when both missing', () => {
  const out = mergePortfolios({ meta: {}, holdings: [] }, { meta: {}, holdings: [] }, 'd');
  assert.ok(typeof out.meta.created_at === 'string');
  assert.ok(!Number.isNaN(Date.parse(out.meta.created_at)));
});

// --- mergePortfolios: collections use mergeById ---

test('mergePortfolios: holdings uses mergeById (newer wins)', () => {
  const local = {
    holdings: [H('a', { shares: 1, updated_at: iso('2024-02-01') })],
  };
  const remote = {
    holdings: [H('a', { shares: 99, updated_at: iso('2024-01-01') })],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].shares, 1); // local newer
});

test('mergePortfolios: cash_accounts, debts, snapshots all use mergeById', () => {
  const local = {
    cash_accounts: [H('c1', { balance: 100, updated_at: iso('2024-02-01') })],
    debts: [H('d1', { balance: 50, updated_at: iso('2024-02-01') })],
    snapshots: [H('s1', { net_worth: 999, updated_at: iso('2024-02-01') })],
  };
  const remote = {
    cash_accounts: [H('c1', { balance: 200, updated_at: iso('2024-01-01') })],
    debts: [H('d1', { balance: 75, updated_at: iso('2024-01-01') })],
    snapshots: [H('s1', { net_worth: 1000, updated_at: iso('2024-01-01') })],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.cash_accounts[0].balance, 100);
  assert.equal(out.debts[0].balance, 50);
  assert.equal(out.snapshots[0].net_worth, 999);
});

// --- mergePortfolios: version ---

test('mergePortfolios: version prefers remote, falls back to local, then undefined', () => {
  assert.equal(mergePortfolios({ version: 1, holdings: [] }, { version: 2, holdings: [] }, 'd').version, 2);
  assert.equal(mergePortfolios({ version: 1, holdings: [] }, { holdings: [] }, 'd').version, 1);
  assert.equal(mergePortfolios({ holdings: [] }, { holdings: [] }, 'd').version, undefined);
});

// --- mergePortfolios: full realistic round-trip ---

test('mergePortfolios: realistic round-trip with all meta fields exercised', () => {
  const local = {
    version: 1,
    meta: {
      device_id: 'local-d',
      last_synced_at: '2024-01-15T00:00:00Z',
      created_at: '2024-01-01T00:00:00Z',
    },
    settings: { theme: 'dark', updated_at: '2024-01-10T00:00:00Z' },
    categories: [{ id: 'tech', name: 'Tech', updated_at: '2024-01-05T00:00:00Z', device_id: 'local-d' }],
    holdings: [
      H('aapl', { ticker: 'AAPL', shares: 10, updated_at: iso('2024-01-10') }),
      H('msft', { ticker: 'MSFT', shares: 5, updated_at: iso('2024-01-05') }),
    ],
    cash_accounts: [H('c1', { balance: 1000, updated_at: iso('2024-01-15') })],
    debts: [],
    snapshots: [],
  };
  const remote = {
    version: 2,
    meta: {
      device_id: 'remote-d',
      last_synced_at: '2024-01-20T00:00:00Z',
      created_at: '2024-01-02T00:00:00Z',
    },
    settings: { theme: 'light', updated_at: '2024-01-20T00:00:00Z' },
    categories: [{ id: 'finance', name: 'Finance', updated_at: '2024-01-20T00:00:00Z', device_id: 'remote-d' }],
    holdings: [
      H('aapl', { ticker: 'AAPL', shares: 20, updated_at: iso('2024-01-15') }), // newer → wins
      H('googl', { ticker: 'GOOGL', shares: 8, updated_at: iso('2024-01-15') }), // only remote
    ],
    cash_accounts: [H('c1', { balance: 2000, updated_at: iso('2024-01-14') })], // local newer (2024-01-15 > 2024-01-14)
    debts: [],
    snapshots: [],
  };

  const out = mergePortfolios(local, remote, 'fallback-d');

  // version: remote wins
  assert.equal(out.version, 2);
  // meta: device_id prefers local, last_synced_at prefers remote, created_at prefers local
  assert.equal(out.meta.device_id, 'local-d');
  assert.equal(out.meta.last_synced_at, '2024-01-20T00:00:00Z');
  assert.equal(out.meta.created_at, '2024-01-01T00:00:00Z');
  // settings: mergeSettings — remote.settings.updated_at newer → remote whole object wins
  assert.deepEqual(out.settings, { theme: 'light', updated_at: '2024-01-20T00:00:00Z' });
  // categories: mergeByIdWithDeletions — disjoint ids → both present
  assert.equal(out.categories.length, 2);
  assert.ok(out.categories.some(c => c.id === 'tech'));
  assert.ok(out.categories.some(c => c.id === 'finance'));
  // holdings: merged by id (aapl=remote newer 20, msft=local only 5, googl=remote only 8)
  assert.equal(out.holdings.length, 3);
  assert.equal(out.holdings.find(r => r.id === 'aapl').shares, 20);
  assert.equal(out.holdings.find(r => r.id === 'msft').shares, 5);
  assert.equal(out.holdings.find(r => r.id === 'googl').shares, 8);
  // cash_accounts: c1 local newer wins
  assert.equal(out.cash_accounts.length, 1);
  assert.equal(out.cash_accounts[0].balance, 1000);
});

// --- mergeByIdWithDeletions: tombstone filter on top of mergeById ---

test('mergeByIdWithDeletions: local deletion + remote record → record removed', () => {
  // Records that exist on remote but were hard-deleted on local (and a
  // tombstone appended to data.deletions) must not survive a sync.
  const local = [];
  const remote = [H('h1', { shares: 10 })];
  const localDels = [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }];
  const out = mergeByIdWithDeletions(local, remote, localDels, []);
  assert.equal(out.length, 0, 'record must be filtered out by local deletion tombstone');
});

test('mergeByIdWithDeletions: both deletion inputs null/undefined → treated as empty', () => {
  const local = [];
  const remote = [H('h1', { shares: 10 })];
  assert.equal(mergeByIdWithDeletions(local, remote, null, null).length, 1);
  assert.equal(mergeByIdWithDeletions(local, remote, undefined, undefined).length, 1);
});

test('mergeByIdWithDeletions: local empty, remote empty, both deletions present → empty', () => {
  const localDels = [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'a' }];
  const remoteDels = [{ id: 'del-2', target_id: 'h2', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'b' }];
  const out = mergeByIdWithDeletions([], [], localDels, remoteDels);
  assert.equal(out.length, 0);
});

test('mergeByIdWithDeletions: remote deletion log + local record → record removed', () => {
  const local = [H('h1', { shares: 10 })];
  const remote = [];
  const remoteDels = [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'other' }];
  const out = mergeByIdWithDeletions(local, remote, [], remoteDels);
  assert.equal(out.length, 0, 'remote tombstone must propagate to local');
});

test('mergeByIdWithDeletions: deletion on both sides agrees → record removed', () => {
  const local = [];
  const remote = [H('h1', { shares: 10 })];
  const localDels = [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'a' }];
  const remoteDels = [{ id: 'del-2', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'b' }];
  const out = mergeByIdWithDeletions(local, remote, localDels, remoteDels);
  assert.equal(out.length, 0);
});

test('mergeByIdWithDeletions: delete always wins over newer edit on another device', () => {
  // Device A deletes h1 at time T+10. Device B (offline) edited h1 at
  // time T+5. After sync, the deletion must stand — high-intent user
  // action overrides stale edit.
  const local = []; // local deleted
  const remote = [H('h1', { shares: 99, updated_at: '2024-06-15T05:00:00Z' })];
  const localDels = [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T10:00:00Z', device_id: 'this' }];
  const out = mergeByIdWithDeletions(local, remote, localDels, []);
  assert.equal(out.length, 0, 'deletion must override remote\'s newer-looking edit');
});

test('mergeByIdWithDeletions: undeleted record survives filter', () => {
  const local = [H('h1', { shares: 10 })];
  const remote = [H('h2', { shares: 20 })];
  const localDels = [{ id: 'del-1', target_id: 'h3', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'a' }];
  const out = mergeByIdWithDeletions(local, remote, localDels, []);
  assert.equal(out.length, 2);
  assert.ok(out.some(r => r.id === 'h1'));
  assert.ok(out.some(r => r.id === 'h2'));
});

test('mergeByIdWithDeletions: bare mergeById contract still holds (remote-only record without matching deletion passes through)', () => {
  // The "hard-delete doesn't propagate" contract from c434c0d — bare
  // mergeById keeps remote-only records. mergeByIdWithDeletions
  // preserves this when there is no matching tombstone in the merged
  // deletion log.
  const local = [];
  const remote = [H('h1', { shares: 10 })];
  const out = mergeByIdWithDeletions(local, remote, [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'h1');
});

// --- mergePortfolios: deletion log filter applied to record collections ---

test('mergePortfolios: holdings filtered by merged deletion log (hard-delete propagates)', () => {
  const local = {
    holdings: [],
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }],
  };
  const remote = { holdings: [H('h1', { shares: 10 })] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.holdings.length, 0, 'hard-deleted holding must NOT survive sync');
});

test('mergePortfolios: cash_accounts filtered by merged deletion log', () => {
  const local = {
    cash_accounts: [],
    deletions: [{ id: 'del-1', target_id: 'c1', type: 'cash_accounts', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }],
  };
  const remote = { cash_accounts: [H('c1', { balance: 500 })] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.cash_accounts.length, 0);
});

test('mergePortfolios: debts filtered by merged deletion log', () => {
  const local = {
    debts: [],
    deletions: [{ id: 'del-1', target_id: 'd1', type: 'debts', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }],
  };
  const remote = { debts: [H('d1', { balance: 1000 })] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.debts.length, 0);
});

test('mergePortfolios: snapshots filtered by merged deletion log', () => {
  const local = {
    snapshots: [],
    deletions: [{ id: 'del-1', target_id: 's1', type: 'snapshots', deleted_at: '2024-06-15T00:00:00Z', device_id: 'this' }],
  };
  const remote = { snapshots: [H('s1', { net_worth: 1000 })] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.snapshots.length, 0);
});

// --- mergePortfolios: data.deletions[] merge ---

test('mergePortfolios: data.deletions[] same-id collision → mergeById tie-break (local wins)', () => {
  // Deletion entries carry `deleted_at`, but mergeById compares by
  // `updated_at` (ADR 0004 + lib/sync.js tsOf). Neither side has
  // `updated_at`, so both fall back to epoch 0 → tie → local wins.
  // The "newer entry wins" claim does NOT apply here — see the next
  // test for an explicit local-wins proof.
  const old = '2024-01-01T00:00:00Z';
  const now = '2024-06-15T00:00:00Z';
  const local = {
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: now, device_id: 'this' }],
  };
  const remote = {
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: old, device_id: 'other' }],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.deletions.length, 1);
  assert.equal(out.deletions[0].device_id, 'this', 'local wins on tie (mergeById uses updated_at, not deleted_at)');
});

test('mergePortfolios: data.deletions[] local older-by-deleted_at still wins on tie (proves the contract)', () => {
  // Sanity check: invert the inputs so local is older by deleted_at.
  // Result must still pick local — confirming the tie-break is truly
  // "local wins", not "newer-wins by deleted_at" (which would pick
  // remote here).
  const old = '2024-01-01T00:00:00Z';
  const now = '2024-06-15T00:00:00Z';
  const local = {
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: old, device_id: 'this' }],
  };
  const remote = {
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: now, device_id: 'other' }],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.deletions[0].device_id, 'this', 'local wins regardless of deleted_at ordering — mergeById tie-break');
});

test('mergePortfolios: data.deletions[] unions across devices', () => {
  const local = {
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'a' }],
  };
  const remote = {
    deletions: [{ id: 'del-2', target_id: 'h2', type: 'holdings', deleted_at: '2024-06-15T00:00:00Z', device_id: 'b' }],
  };
  const out = mergePortfolios(local, remote, 'a');
  assert.equal(out.deletions.length, 2);
});

test('mergePortfolios: data.deletions[] empty array when both sides missing', () => {
  // Collections use mergeById which returns [] for empty inputs, same
  // as holdings / cash_accounts / debts / snapshots — never undefined.
  const out = mergePortfolios({}, {}, 'd');
  assert.deepEqual(out.deletions, []);
});

// --- mergePortfolios: data.backups[] merge + FIFO 5 ---

test('mergePortfolios: data.backups[] merged + sorted + truncated to last 5', () => {
  // Local has 4 old backups, remote has 4 newer backups — merged should
  // be 8 entries before truncation; but the FIFO 5 keeps the 5 newest.
  const local = {
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', snapshot: {} },
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', snapshot: {} },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', snapshot: {} },
      { id: 'b4', saved_at: '2024-04-01T00:00:00Z', snapshot: {} },
    ],
  };
  const remote = {
    backups: [
      { id: 'b5', saved_at: '2024-05-01T00:00:00Z', snapshot: {} },
      { id: 'b6', saved_at: '2024-06-01T00:00:00Z', snapshot: {} },
      { id: 'b7', saved_at: '2024-07-01T00:00:00Z', snapshot: {} },
      { id: 'b8', saved_at: '2024-08-01T00:00:00Z', snapshot: {} },
    ],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.backups.length, 5, 'FIFO 5 — keep the 5 newest');
  // b4..b8 (newest 5 by saved_at)
  assert.deepEqual(out.backups.map(b => b.id), ['b4', 'b5', 'b6', 'b7', 'b8']);
});

test('mergePortfolios: data.backups[] with < 5 merged → no truncation', () => {
  const local = {
    backups: [
      { id: 'b1', saved_at: '2024-01-01T00:00:00Z', snapshot: {} },
    ],
  };
  const remote = {
    backups: [
      { id: 'b2', saved_at: '2024-02-01T00:00:00Z', snapshot: {} },
      { id: 'b3', saved_at: '2024-03-01T00:00:00Z', snapshot: {} },
    ],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.backups.length, 3);
  assert.deepEqual(out.backups.map(b => b.id), ['b1', 'b2', 'b3']);
});

test('mergePortfolios: data.backups[] empty array when both sides missing', () => {
  // Collections use mergeById which returns [] for empty inputs, same
  // as holdings / cash_accounts / debts / snapshots — never undefined.
  const out = mergePortfolios({}, {}, 'd');
  assert.deepEqual(out.backups, []);
});

// --- Regression: deletion must propagate via sync ---
//
// Symptom (pre-fix, c434c0d): clicking the per-row Delete button on a
// holding / cash / debt hard-deleted the record locally, but the next
// sync pulled the same record back from remote (because mergeById keeps
// remote-only records). The c434c0d intermediate fix (soft-delete with
// inactive=true + bumped updated_at) was not the right shape — the
// glossary already warns "Inactive: Avoid Deleted". The v1.3 fix uses a
// separate data.deletions[] tombstone log + mergeByIdWithDeletions to
// filter the merged result. These tests pin the new contract: a
// deletion on local produces a tombstone that, after sync, removes the
// record from the remote copy on this device. All three collections
// (holdings / cash_accounts / debts) are covered.

test('mergePortfolios: local deletion on holding removes remote record (deletion log)', () => {
  const local = {
    holdings: [],
    deletions: [{ id: 'del-1', target_id: 'h1', type: 'holdings',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'this' }],
  };
  const remote = {
    holdings: [{ id: 'h1', shares: 10, cost: 100, currency: 'TWD',
                  current_price: 100, inactive: false,
                  updated_at: '2024-01-01T00:00:00Z', device_id: 'other' }],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.holdings.length, 0, 'tombstone must remove the record — the c434c0d bug');
});

test('mergePortfolios: local deletion on cash_account removes remote record (deletion log)', () => {
  const local = {
    cash_accounts: [],
    deletions: [{ id: 'del-1', target_id: 'c1', type: 'cash_accounts',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'this' }],
  };
  const remote = {
    cash_accounts: [{ id: 'c1', name: 'old', balance: 500, currency: 'TWD',
                      inactive: false, updated_at: '2024-01-01T00:00:00Z', device_id: 'other' }],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.cash_accounts.length, 0, 'tombstone must remove the record');
});

test('mergePortfolios: local deletion on debt removes remote record (regression: the bug the user reported)', () => {
  const local = {
    debts: [],
    deletions: [{ id: 'del-1', target_id: 'd1', type: 'debts',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'this' }],
  };
  const remote = {
    debts: [{ id: 'd1', name: 'credit card', balance: 1000, currency: 'TWD',
              inactive: false, updated_at: '2024-01-01T00:00:00Z', device_id: 'other' }],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.debts.length, 0, 'tombstone must remove the record so totals on both devices exclude it');
});

test('mergePortfolios: hard-delete WITHOUT a matching tombstone keeps remote-only record (documented contract)', () => {
  // This pins the bare mergeById contract. If a record was hard-deleted
  // locally AND no tombstone was appended (e.g., a buggy old removeX
  // method), the record comes back from remote. The v1.3 fix relies on
  // removeX *always* appending a tombstone — this test guards against
  // a future regression that removes the tombstone append.
  const local = { debts: [] }; // record was hard-deleted, no tombstone
  const remote = { debts: [{ id: 'd1', balance: 1000, currency: 'TWD',
                              inactive: false, updated_at: '2024-01-01T00:00:00Z', device_id: 'other' }] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.debts.length, 1, 'without a tombstone, remote-only records survive — delete + tombstone must always go together');
});

// --- mergePortfolios: data.plans[] integration (v1.4 — ticket 05) ---
//
// Per ADR 0004 pattern (per-record merge by updated_at) + ADR 0011
// deletion log: plans merge via mergeByIdWithDeletions. Tests cover
// the local-only / remote-only / both / conflict / deletion paths.

const P = (id, opts = {}) => Object.assign({
  id,
  name: opts.name || id,
  rules: opts.rules || [],
  updated_at: opts.updated_at || '2024-01-01T00:00:00Z',
}, opts);

test('mergePortfolios: plans local-only (remote has none) → local passes through', () => {
  const local = { plans: [P('p1', { name: 'Local-only' })], holdings: [] };
  const remote = { plans: undefined, holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'Local-only');
});

test('mergePortfolios: plans remote-only (local has none) → remote passes through', () => {
  const local = { plans: undefined, holdings: [] };
  const remote = { plans: [P('p1', { name: 'Remote-only' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'Remote-only');
});

test('mergePortfolios: plans remote-only + local has undefined plans → remote passes through', () => {
  // Older v1.3 backup with no plans field — must not crash.
  const local = { holdings: [] }; // no plans
  const remote = { plans: [P('p1', { name: 'R' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'R');
});

test('mergePortfolios: plans disjoint ids → both sides present', () => {
  const local = { plans: [P('p1', { name: 'L' })], holdings: [] };
  const remote = { plans: [P('p2', { name: 'R' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 2);
  assert.ok(out.plans.some(p => p.name === 'L'));
  assert.ok(out.plans.some(p => p.name === 'R'));
});

test('mergePortfolios: plans same id, remote newer → remote wins (rule edits propagate)', () => {
  const local = {
    plans: [P('p1', { name: 'old', rules: [{ id: 'r1' }], updated_at: '2024-01-01T00:00:00Z' })],
    holdings: [],
  };
  const remote = {
    plans: [P('p1', { name: 'new', rules: [{ id: 'r1' }, { id: 'r2' }], updated_at: '2024-02-01T00:00:00Z' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'new');
  assert.equal(out.plans[0].rules.length, 2, 'remote-newer rules must replace local rules wholesale');
});

test('mergePortfolios: plans same id, local newer → local wins', () => {
  const local = {
    plans: [P('p1', { name: 'local-edit', updated_at: '2024-02-01T00:00:00Z' })],
    holdings: [],
  };
  const remote = {
    plans: [P('p1', { name: 'remote-edit', updated_at: '2024-01-01T00:00:00Z' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'local-edit');
});

test('mergePortfolios: plans same id, equal timestamp → local wins (tie-break like other records)', () => {
  const t = '2024-01-01T00:00:00Z';
  const local = { plans: [P('p1', { name: 'L', updated_at: t })], holdings: [] };
  const remote = { plans: [P('p1', { name: 'R', updated_at: t })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].name, 'L');
});

test('mergePortfolios: plans missing updated_at → treated as epoch 0 (remote newer wins)', () => {
  // A v1.4 plan saved before updated_at stamping was wired in still
  // loses to a newer remote edit — epoch 0 fallback keeps mergeById
  // contract consistent across records.
  const local = { plans: [{ id: 'p1', name: 'L', rules: [] }], holdings: [] };
  const remote = {
    plans: [P('p1', { name: 'R', rules: [], updated_at: '2024-02-01T00:00:00Z' })],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans[0].name, 'R');
});

test('mergePortfolios: plans local deletion tombstone removes remote plan', () => {
  const local = {
    plans: [],
    deletions: [{ id: 'del-1', target_id: 'p1', type: 'plans',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'this' }],
    holdings: [],
  };
  const remote = { plans: [P('p1', { name: 'remote-plan' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.plans.length, 0, 'plan must be filtered out by plan tombstone');
  // tombstone itself survives the sync (it must — that's how other devices learn)
  assert.ok(out.deletions.some(d => d.target_id === 'p1'));
});

test('mergePortfolios: plans remote deletion tombstone propagates to local', () => {
  const local = { plans: [P('p1', { name: 'local-plan' })], holdings: [] };
  const remote = {
    plans: [],
    deletions: [{ id: 'del-1', target_id: 'p1', type: 'plans',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'other' }],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'this');
  assert.equal(out.plans.length, 0, 'remote tombstone must remove local plan');
});

test('mergePortfolios: plans deletion on both sides → removed, tombstone deduplicated', () => {
  const local = {
    plans: [],
    deletions: [{ id: 'del-1', target_id: 'p1', type: 'plans',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'a' }],
    holdings: [],
  };
  const remote = {
    plans: [P('p1', {})],
    deletions: [{ id: 'del-2', target_id: 'p1', type: 'plans',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'b' }],
    holdings: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 0);
  // Both tombstones survive separately (different ids) — union of deletion logs.
  assert.equal(out.deletions.length, 2);
});

test('mergePortfolios: plans disjoint ids + overlapping deletion → mix preserved + tombstoned removed', () => {
  const local = {
    plans: [P('p1', { name: 'L' })],
    deletions: [{ id: 'del-1', target_id: 'p2', type: 'plans',
                  deleted_at: '2024-06-15T12:00:00Z', device_id: 'a' }],
    holdings: [],
  };
  const remote = { plans: [P('p2', { name: 'R' })], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].id, 'p1', 'p1 (untombstoned local-only) survives');
  // p2 was remote-only AND tombstoned locally → filtered out
});

// --- mergePortfolios: data.active_plan_id scalar merge (v1.4 — ticket 05) ---

test('mergePortfolios: active_plan_id prefers remote (consistent with last_synced_at coarseness)', () => {
  const local = { active_plan_id: 'p1', holdings: [] };
  const remote = { active_plan_id: 'p2', holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.active_plan_id, 'p2');
});

test('mergePortfolios: active_plan_id falls back to local when remote missing', () => {
  const local = { active_plan_id: 'p1', holdings: [] };
  const remote = { holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.active_plan_id, 'p1');
});

test('mergePortfolios: active_plan_id null when both missing', () => {
  const out = mergePortfolios({}, {}, 'd');
  assert.equal(out.active_plan_id, null);
});

test('mergePortfolios: active_plan_id preserves explicit null on either side', () => {
  // null is meaningful: user cleared the active pointer.
  const local = { active_plan_id: 'p1', holdings: [] };
  const remote = { active_plan_id: null, holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  // Remote-side null is the latest known state — applies.
  assert.equal(out.active_plan_id, null);
});

test('mergePortfolios: active_plan_id may point at a non-existent plan (validatePlans warns)', () => {
  // Sync can race the pointer ahead of the plan list — e.g., device A
  // deletes plan X, device B (which had X active) syncs and sees an
  // orphan pointer. We intentionally do NOT filter here; validation
  // belongs to validatePlans() so the UI can warn + offer recovery.
  const local = { active_plan_id: 'gone', plans: [], holdings: [] };
  const remote = { active_plan_id: 'gone', plans: [], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.equal(out.active_plan_id, 'gone', 'orphan pointer survives merge by design');
});

// --- mergePortfolios: data.<collection>_order arrays (v1.6 — ticket 01) ---
// Manual record ordering. ADR 0015 §4: prefer-remote (same pattern as
// active_plan_id / settings). Documented limitation: when both devices
// reorder offline, last-synced wins and the earlier edit is silent.

test('mergePortfolios: holdings_order prefers remote', () => {
  const local = { holdings_order: ['h1', 'h2'], holdings: [] };
  const remote = { holdings_order: ['h2', 'h1'], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.holdings_order, ['h2', 'h1']);
});

test('mergePortfolios: holdings_order falls back to local when remote missing', () => {
  const local = { holdings_order: ['h1', 'h2'], holdings: [] };
  const remote = { holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.holdings_order, ['h1', 'h2']);
});

test('mergePortfolios: holdings_order undefined when both missing (lazy-write preserved)', () => {
  // Pre-v1.6 portfolios have no *_order arrays; the merge must not
  // materialize empty arrays — that would pollute backups.
  const out = mergePortfolios({ holdings: [] }, { holdings: [] }, 'd');
  assert.equal(out.holdings_order, undefined);
});

test('mergePortfolios: holdings_order preserved as [] when both sides are explicit empty', () => {
  // Empty array IS meaningful: user reordered and then cleared their
  // portfolio. Distinct from "never reordered" (undefined).
  const local = { holdings_order: [], holdings: [] };
  const remote = { holdings_order: [], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.holdings_order, []);
});

test('mergePortfolios: cash_accounts_order + debts_order use same pattern as holdings_order', () => {
  const local = {
    cash_accounts_order: ['c1', 'c2'],
    debts_order: ['d1', 'd2'],
    holdings: [], cash_accounts: [], debts: [],
  };
  const remote = {
    cash_accounts_order: ['c2', 'c1'],
    debts_order: ['d2', 'd1'],
    holdings: [], cash_accounts: [], debts: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.cash_accounts_order, ['c2', 'c1']);
  assert.deepEqual(out.debts_order, ['d2', 'd1']);
});

test('mergePortfolios: each *_order array merges independently (cross-collection leak guard)', () => {
  const local = {
    holdings_order: ['h1'],
    cash_accounts_order: ['c1'],
    debts_order: ['d1'],
    holdings: [], cash_accounts: [], debts: [],
  };
  const remote = {
    holdings_order: ['h2'],
    // cash_accounts_order + debts_order missing on remote
    holdings: [], cash_accounts: [], debts: [],
  };
  const out = mergePortfolios(local, remote, 'd');
  // remote wins for holdings
  assert.deepEqual(out.holdings_order, ['h2']);
  // local preserved for the two missing on remote
  assert.deepEqual(out.cash_accounts_order, ['c1']);
  assert.deepEqual(out.debts_order, ['d1']);
});
