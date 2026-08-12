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

test('mergePortfolios: data.deletions[] merged via mergeById (newer entry wins)', () => {
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
  assert.equal(out.deletions[0].device_id, 'this', 'newer deletion wins');
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
