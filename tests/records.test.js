// tests/records.test.js — Unit tests for lib/records.js
//
// Run via:  node --test tests/records.test.js
//   or:     ./test.sh  (auto-discovers *.test.js except worker contract)

const test = require('node:test');
const assert = require('node:assert/strict');
const Records = require('../lib/records.js');
const { recordDeletion } = Records;

const baseOpts = {
  type: 'holdings',
  deviceId: 'dev-a',
  deletedAt: '2024-06-15T00:00:00Z',
  genDelId: () => 'del-1',
};

test('recordDeletion: removes record and appends tombstone', () => {
  const records = [{ id: 'h1', shares: 10 }, { id: 'h2', shares: 20 }];
  const deletions = [];
  const out = recordDeletion(records, deletions, { ...baseOpts, targetId: 'h1' });
  assert.equal(out.didDelete, true);
  assert.deepEqual(out.records, [{ id: 'h2', shares: 20 }]);
  assert.deepEqual(out.deletions, [{
    id: 'del-1',
    target_id: 'h1',
    type: 'holdings',
    deleted_at: '2024-06-15T00:00:00Z',
    device_id: 'dev-a',
  }]);
});

test('recordDeletion: tombstone shape matches sync deletion-log contract', () => {
  // Pins the wire shape that lib/sync.js expects on data.deletions[].
  // If any field name changes, sync.test.js will fail too — but this
  // test is the contract owner.
  const out = recordDeletion([{ id: 'h1' }], [], { ...baseOpts, targetId: 'h1' });
  const t = out.deletions[0];
  assert.equal(t.id, 'del-1');
  assert.equal(t.target_id, 'h1');
  assert.equal(t.type, 'holdings');
  assert.equal(t.deleted_at, '2024-06-15T00:00:00Z');
  assert.equal(t.device_id, 'dev-a');
});

test('recordDeletion: missing targetId returns inputs unchanged and didDelete: false', () => {
  const records = [{ id: 'h1' }];
  const deletions = [];
  const out = recordDeletion(records, deletions, { ...baseOpts, targetId: 'h99' });
  assert.equal(out.didDelete, false);
  assert.equal(out.records, records); // same reference — no spurious allocation
  assert.equal(out.deletions, deletions);
});

test('recordDeletion: genDelId is called exactly once on a successful deletion', () => {
  const records = [{ id: 'h1' }];
  let calls = 0;
  const genDelId = () => { calls += 1; return `del-${calls}`; };
  const out = recordDeletion(records, [], { ...baseOpts, targetId: 'h1', genDelId });
  assert.equal(calls, 1);
  assert.equal(out.deletions[0].id, 'del-1');
});

test('recordDeletion: genDelId is NOT called when target is missing', () => {
  let calls = 0;
  const genDelId = () => { calls += 1; return `del-${calls}`; };
  const out = recordDeletion([{ id: 'h1' }], [], { ...baseOpts, targetId: 'h99', genDelId });
  assert.equal(calls, 0);
  assert.equal(out.didDelete, false);
});

test('recordDeletion: null/undefined records → didDelete: false, no throw', () => {
  const out = recordDeletion(null, [], { ...baseOpts, targetId: 'h1' });
  assert.equal(out.didDelete, false);
  assert.deepEqual(out.records, []);
});

test('recordDeletion: null/undefined deletions → treated as empty', () => {
  const out = recordDeletion([{ id: 'h1' }], null, { ...baseOpts, targetId: 'h1' });
  assert.equal(out.didDelete, true);
  assert.equal(out.deletions.length, 1);
  assert.equal(out.deletions[0].id, 'del-1');
});

test('recordDeletion: never mutates input arrays', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }];
  const deletions = [];
  const beforeRecords = records.slice();
  const beforeDeletions = deletions.slice();
  recordDeletion(records, deletions, { ...baseOpts, targetId: 'h1' });
  assert.deepEqual(records, beforeRecords);
  assert.deepEqual(deletions, beforeDeletions);
});

test('recordDeletion: deleting first / middle / last preserves order of the rest', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
  assert.deepEqual(
    recordDeletion(records, [], { ...baseOpts, targetId: 'h1' }).records,
    [{ id: 'h2' }, { id: 'h3' }],
  );
  assert.deepEqual(
    recordDeletion(records, [], { ...baseOpts, targetId: 'h2' }).records,
    [{ id: 'h1' }, { id: 'h3' }],
  );
  assert.deepEqual(
    recordDeletion(records, [], { ...baseOpts, targetId: 'h3' }).records,
    [{ id: 'h1' }, { id: 'h2' }],
  );
});

test('recordDeletion: appends to existing deletions without dropping prior tombstones', () => {
  const records = [{ id: 'h1' }];
  const prior = [{
    id: 'del-prior', target_id: 'h0', type: 'holdings',
    deleted_at: '2024-05-01T00:00:00Z', device_id: 'dev-b',
  }];
  const out = recordDeletion(records, prior, { ...baseOpts, targetId: 'h1' });
  assert.equal(out.deletions.length, 2);
  assert.equal(out.deletions[0].id, 'del-prior');
  assert.equal(out.deletions[1].id, 'del-1');
  assert.equal(out.deletions[1].target_id, 'h1');
});

// --- v1.7 — type: 'categories' is permitted (ADR 0011 type enum extension) ---

test('recordDeletion: type=categories appends tombstone with category target (ADR 0016 §3)', () => {
  // v1.7 extends the ADR 0011 type enum with 'categories' so that
  // deleteCategory pushes tombstones that propagate across devices.
  // recordDeletion is type-agnostic at the data layer; this test pins
  // the wire shape that deleteCategory will produce.
  const out = recordDeletion(
    [{ id: 'cat-1', name: 'Tech' }],
    [],
    {
      targetId: 'cat-1',
      type: 'categories',                  // ← ADR 0011 enum extension
      deviceId: 'dev-a',
      deletedAt: '2024-08-15T00:00:00Z',
      genDelId: () => 'del-cat-1',
    }
  );
  assert.equal(out.didDelete, true);
  assert.deepEqual(out.records, []);
  assert.deepEqual(out.deletions, [{
    id: 'del-cat-1',
    target_id: 'cat-1',
    type: 'categories',                    // ← enum extended, type matches
    deleted_at: '2024-08-15T00:00:00Z',
    device_id: 'dev-a',
  }]);
});

test('recordDeletion: types across collections coexist in the deletion log (mixed-type)', () => {
  // The data.deletions[] log is a single array across all record-bearing
  // collections. Pins the contract: 'categories' tombstones can sit in
  // the same array as 'holdings' / 'cash_accounts' / 'debts' /
  // 'snapshots' / 'plans' tombstones without confusion.
  const records = [{ id: 'cat-1', name: 'Tech' }];
  const prior = [
    { id: 'del-h1', target_id: 'h1', type: 'holdings',
      deleted_at: '2024-05-01T00:00:00Z', device_id: 'd' },
    { id: 'del-c1', target_id: 'c1', type: 'cash_accounts',
      deleted_at: '2024-06-01T00:00:00Z', device_id: 'd' },
    { id: 'del-d1', target_id: 'd1', type: 'debts',
      deleted_at: '2024-06-02T00:00:00Z', device_id: 'd' },
    { id: 'del-s1', target_id: 's1', type: 'snapshots',
      deleted_at: '2024-06-03T00:00:00Z', device_id: 'd' },
    { id: 'del-p1', target_id: 'p1', type: 'plans',
      deleted_at: '2024-06-04T00:00:00Z', device_id: 'd' },
  ];
  const out = recordDeletion(records, prior, {
    targetId: 'cat-1',
    type: 'categories',
    deviceId: 'd',
    deletedAt: '2024-08-15T00:00:00Z',
    genDelId: () => 'del-cat-1',
  });
  assert.equal(out.deletions.length, 6, 'pre-existing tombstones preserved + new category tombstone');
  assert.deepEqual(
    out.deletions.map(d => d.type),
    ['holdings', 'cash_accounts', 'debts', 'snapshots', 'plans', 'categories'],
    'type field is preserved per-tombstone — single log serves all collections'
  );
});