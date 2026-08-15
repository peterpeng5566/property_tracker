// tests/order.test.js — Unit tests for lib/order.js
//
// Run via:  node --test tests/order.test.js
//   or:     ./test.sh  (auto-discovers *.test.js)
//
// Source of truth: lib/order.js + ADR 0015 (v1.6 record ordering).
//   - Storage shape: per-collection ID array (holdings_order /
//     cash_accounts_order / debts_order).
//   - Lazy-write: array absent until user first reorders.
//   - All helpers are pure: never mutate inputs.
//
// Tests verify behavior through the public interface (the 4 exports).
// TDD seam: `lib/order.js`'s `root.Order = api` namespace, identical
// to lib/records.js / lib/snapshot.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Order = require('../lib/order.js');
const { applyOrder, moveItem, appendToOrder, removeFromOrder } = Order;

// --- applyOrder: defensive inputs ---

test('applyOrder: null/undefined records → []', () => {
  assert.deepEqual(applyOrder(null, ['h1']), []);
  assert.deepEqual(applyOrder(undefined, ['h1']), []);
});

test('applyOrder: null/undefined ids → returns shallow clone of records', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }];
  const out = applyOrder(records, null);
  assert.deepEqual(out, records);
  assert.notEqual(out, records, 'must not return the same reference (input not mutated)');
});

test('applyOrder: ids is not an array → returns shallow clone of records', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }];
  assert.deepEqual(applyOrder(records, 'h1'), records);
  assert.deepEqual(applyOrder(records, {}), records);
});

// --- applyOrder: empty inputs ---

test('applyOrder: empty records + empty ids → []', () => {
  assert.deepEqual(applyOrder([], []), []);
});

test('applyOrder: empty ids → returns records in insertion order', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
  assert.deepEqual(applyOrder(records, []), records);
});

test('applyOrder: empty records + non-empty ids → []', () => {
  assert.deepEqual(applyOrder([], ['h1', 'h2']), []);
});

// --- applyOrder: happy path ---

test('applyOrder: reorders records per ids', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
  const out = applyOrder(records, ['h3', 'h1', 'h2']);
  assert.deepEqual(out.map(r => r.id), ['h3', 'h1', 'h2']);
});

// --- applyOrder: defensive filtering ---

test('applyOrder: drops stale ids (not present in records)', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }];
  const out = applyOrder(records, ['h1', 'h-gone', 'h2']);
  assert.deepEqual(out.map(r => r.id), ['h1', 'h2']);
});

test('applyOrder: appends records whose id is not in ids (leftovers)', () => {
  // Simulates a record added after the order array was materialized.
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
  const out = applyOrder(records, ['h2']);
  assert.deepEqual(out.map(r => r.id), ['h2', 'h1', 'h3']);
});

test('applyOrder: skips non-string ids (defensive against sync corruption)', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }];
  // null and 123 are not valid IDs — drop them.
  const out = applyOrder(records, [null, 'h1', 123, 'h2']);
  assert.deepEqual(out.map(r => r.id), ['h1', 'h2']);
});

test('applyOrder: leftovers appended in their original relative order', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }];
  // Order array mentions h2 + h4. h1 + h3 are leftovers → appended.
  const out = applyOrder(records, ['h4', 'h2']);
  assert.deepEqual(out.map(r => r.id), ['h4', 'h2', 'h1', 'h3']);
});

// --- applyOrder: immutability ---

test('applyOrder: input records array is never mutated', () => {
  const records = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
  const before = records.slice();
  applyOrder(records, ['h3', 'h1', 'h2']);
  assert.deepEqual(records, before);
});

// --- moveItem: happy path ---

test('moveItem: move middle element to top', () => {
  const out = moveItem(['a', 'b', 'c', 'd'], 2, 0);
  assert.deepEqual(out, ['c', 'a', 'b', 'd']);
});

test('moveItem: move top element to bottom', () => {
  const out = moveItem(['a', 'b', 'c', 'd'], 0, 3);
  assert.deepEqual(out, ['b', 'c', 'd', 'a']);
});

test('moveItem: move bottom element up by one', () => {
  const out = moveItem(['a', 'b', 'c'], 2, 1);
  assert.deepEqual(out, ['a', 'c', 'b']);
});

// --- moveItem: edge cases ---

test('moveItem: fromIndex === toIndex → no-op, same reference', () => {
  const arr = ['a', 'b', 'c'];
  const out = moveItem(arr, 1, 1);
  assert.equal(out, arr);
});

test('moveItem: fromIndex out of range → no-op, same reference', () => {
  const arr = ['a', 'b', 'c'];
  const out = moveItem(arr, 5, 0);
  assert.equal(out, arr);
});

test('moveItem: toIndex out of range → no-op, same reference', () => {
  const arr = ['a', 'b', 'c'];
  const out = moveItem(arr, 0, 5);
  assert.equal(out, arr);
});

test('moveItem: negative fromIndex → no-op, same reference', () => {
  const arr = ['a', 'b', 'c'];
  const out = moveItem(arr, -1, 0);
  assert.equal(out, arr);
});

test('moveItem: null/undefined input → no-op', () => {
  assert.equal(moveItem(null, 0, 1), null);
  assert.equal(moveItem(undefined, 0, 1), undefined);
});

// --- moveItem: immutability ---

test('moveItem: input array is never mutated', () => {
  const arr = ['a', 'b', 'c', 'd'];
  const before = arr.slice();
  moveItem(arr, 2, 0);
  assert.deepEqual(arr, before);
});

// --- appendToOrder: happy path ---

test('appendToOrder: append to empty array', () => {
  const out = appendToOrder([], 'h1');
  assert.deepEqual(out, ['h1']);
});

test('appendToOrder: append to existing array', () => {
  const out = appendToOrder(['h1', 'h2'], 'h3');
  assert.deepEqual(out, ['h1', 'h2', 'h3']);
});

// --- appendToOrder: edge cases ---

test('appendToOrder: id already present → no-op, same reference', () => {
  const arr = ['h1', 'h2'];
  const out = appendToOrder(arr, 'h1');
  assert.equal(out, arr);
});

test('appendToOrder: null/undefined order → returns [id]', () => {
  assert.deepEqual(appendToOrder(null, 'h1'), ['h1']);
  assert.deepEqual(appendToOrder(undefined, 'h1'), ['h1']);
});

// --- appendToOrder: immutability ---

test('appendToOrder: input array is never mutated', () => {
  const arr = ['h1'];
  const before = arr.slice();
  appendToOrder(arr, 'h2');
  assert.deepEqual(arr, before);
});

// --- removeFromOrder: happy path ---

test('removeFromOrder: removes present id', () => {
  const out = removeFromOrder(['h1', 'h2', 'h3'], 'h2');
  assert.deepEqual(out, ['h1', 'h3']);
});

test('removeFromOrder: removes first / last', () => {
  assert.deepEqual(removeFromOrder(['h1', 'h2', 'h3'], 'h1'), ['h2', 'h3']);
  assert.deepEqual(removeFromOrder(['h1', 'h2', 'h3'], 'h3'), ['h1', 'h2']);
});

// --- removeFromOrder: edge cases ---

test('removeFromOrder: absent id → no-op, same reference', () => {
  const arr = ['h1', 'h2'];
  const out = removeFromOrder(arr, 'h-missing');
  assert.equal(out, arr);
});

test('removeFromOrder: null/undefined order → returns []', () => {
  assert.deepEqual(removeFromOrder(null, 'h1'), []);
  assert.deepEqual(removeFromOrder(undefined, 'h1'), []);
});

test('removeFromOrder: empty order → returns []', () => {
  const out = removeFromOrder([], 'h1');
  assert.deepEqual(out, []);
});

// --- removeFromOrder: immutability ---

test('removeFromOrder: input array is never mutated', () => {
  const arr = ['h1', 'h2', 'h3'];
  const before = arr.slice();
  removeFromOrder(arr, 'h2');
  assert.deepEqual(arr, before);
});
