// tests/sync.test.js — tests for lib/sync.js (v1.2)
//
// Covers: mergeById() and mergePortfolios()
// Source of truth: lib/sync.js + ADR 0004 (per-record newer-wins by
// updated_at). Sync conflict resolution is pure, no I/O.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../lib/sync.js');
const { mergeById, mergePortfolios } = Sync;

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

// --- mergePortfolios: categories / settings replacement ---

test('mergePortfolios: categories replaced from remote when present', () => {
  const local = { categories: [{ id: 'c1', name: 'Local' }], holdings: [] };
  const remote = { categories: [{ id: 'c2', name: 'Remote' }], holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.categories, [{ id: 'c2', name: 'Remote' }]);
});

test('mergePortfolios: settings replaced from remote when present', () => {
  const local = { settings: { theme: 'dark' }, holdings: [] };
  const remote = { settings: { theme: 'light' }, holdings: [] };
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.settings, { theme: 'light' });
});

test('mergePortfolios: categories fall back to local when remote.categories is undefined', () => {
  const local = { categories: [{ id: 'c1', name: 'Local' }], holdings: [] };
  const remote = { holdings: [] }; // no categories
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.categories, [{ id: 'c1', name: 'Local' }]);
});

test('mergePortfolios: settings fall back to local when remote.settings is undefined', () => {
  const local = { settings: { theme: 'dark' }, holdings: [] };
  const remote = { holdings: [] }; // no settings
  const out = mergePortfolios(local, remote, 'd');
  assert.deepEqual(out.settings, { theme: 'dark' });
});

test('mergePortfolios: both categories missing → undefined', () => {
  const out = mergePortfolios({}, {}, 'd');
  assert.equal(out.categories, undefined);
});

test('mergePortfolios: both settings missing → undefined', () => {
  const out = mergePortfolios({}, {}, 'd');
  assert.equal(out.settings, undefined);
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
    settings: { theme: 'dark' },
    categories: [{ id: 'tech', name: 'Tech' }],
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
    settings: { theme: 'light' },
    categories: [{ id: 'finance', name: 'Finance' }],
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
  // settings/categories: replaced from remote
  assert.deepEqual(out.settings, { theme: 'light' });
  assert.deepEqual(out.categories, [{ id: 'finance', name: 'Finance' }]);
  // holdings: merged by id (aapl=remote newer 20, msft=local only 5, googl=remote only 8)
  assert.equal(out.holdings.length, 3);
  assert.equal(out.holdings.find(r => r.id === 'aapl').shares, 20);
  assert.equal(out.holdings.find(r => r.id === 'msft').shares, 5);
  assert.equal(out.holdings.find(r => r.id === 'googl').shares, 8);
  // cash_accounts: c1 local newer wins
  assert.equal(out.cash_accounts.length, 1);
  assert.equal(out.cash_accounts[0].balance, 1000);
});