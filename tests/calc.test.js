// tests/calc.test.js — tests for lib/calc.js (v1.2)
//
// Covers pure Home-page calculations:
//   holdingsValue / holdingsCost / holdingsGainLoss / holdingsGainLossPct
//   totalCash / totalDebts / netWorth
//   gainLoss(h)        — per-holding, no FX
//   activeCount        — generic active counter for holdings/cash/debts
//
// FX conversion is delegated to lib/format.js toTWD/fromTWD (one place
// owns the rules). All multi-arg functions take (items, displayCurrency,
// fxRate) explicitly so they are testable without Alpine state.
//
// Source of truth: lib/calc.js + spec §"Module: lib/calc.js".

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../lib/calc.js');

const FX = 32.2;

// Helper: build a holding with sensible defaults so each test reads as the
// one or two fields it cares about.
const h = (overrides) => Object.assign(
  { shares: 10, cost: 100, current_price: 100, currency: 'TWD', inactive: false },
  overrides
);

// --- holdingsValue ---

test('holdingsValue: empty array → 0', () => {
  assert.equal(Calc.holdingsValue([], 'TWD', FX), 0);
});

test('holdingsValue: all-inactive → 0', () => {
  const records = [h({ inactive: true }), h({ inactive: true })];
  assert.equal(Calc.holdingsValue(records, 'TWD', FX), 0);
});

test('holdingsValue: single TWD holding, display TWD → unchanged', () => {
  // shares=10 * current_price=100 = 1000 TWD
  assert.equal(Calc.holdingsValue([h()], 'TWD', FX), 1000);
});

test('holdingsValue: single USD holding, display USD → unchanged', () => {
  // shares=10 * current_price=100 = 1000 USD
  assert.equal(Calc.holdingsValue([h({ currency: 'USD' })], 'USD', FX), 1000);
});

test('holdingsValue: USD holding displayed in TWD → converted via fxRate', () => {
  // 1000 USD * 32.2 = 32200 TWD
  assert.equal(Calc.holdingsValue([h({ currency: 'USD' })], 'TWD', FX), 1000 * FX);
});

test('holdingsValue: TWD holding displayed in USD → converted via /fxRate', () => {
  // 1000 TWD / 32.2 = ~31.0559 USD
  const out = Calc.holdingsValue([h()], 'USD', FX);
  assert.ok(Math.abs(out - 1000 / FX) < 1e-9);
});

test('holdingsValue: mixed TWD + USD summed in displayCurrency', () => {
  const records = [
    h({ shares: 10, current_price: 100, currency: 'TWD' }),     // 1000 TWD
    h({ shares: 10, current_price: 100, currency: 'USD' }),     // 1000 USD
  ];
  // display=TWD: 1000 + 1000*32.2 = 33200
  assert.equal(Calc.holdingsValue(records, 'TWD', FX), 1000 + 1000 * FX);
  // display=USD: 1000/32.2 + 1000
  const usd = Calc.holdingsValue(records, 'USD', FX);
  assert.ok(Math.abs(usd - (1000 / FX + 1000)) < 1e-9);
});

test('holdingsValue: current_price=null contributes 0 (not NaN)', () => {
  const records = [
    h({ current_price: 100 }),                 // 1000 TWD
    h({ shares: 5, current_price: null }),     // null*5 = 0
  ];
  assert.equal(Calc.holdingsValue(records, 'TWD', FX), 1000);
});

test('holdingsValue: fxRate change scales USD conversion proportionally', () => {
  const records = [h({ currency: 'USD' })];
  // 1000 USD * 30 = 30000 TWD (vs * 32.2 = 32200)
  assert.equal(Calc.holdingsValue(records, 'TWD', 30), 1000 * 30);
  assert.notEqual(
    Calc.holdingsValue(records, 'TWD', 30),
    Calc.holdingsValue(records, 'TWD', FX)
  );
});

// --- holdingsCost (mirror of holdingsValue) ---

test('holdingsCost: empty / all-inactive → 0', () => {
  assert.equal(Calc.holdingsCost([], 'TWD', FX), 0);
  const records = [h({ inactive: true, cost: 99999 })];
  assert.equal(Calc.holdingsCost(records, 'TWD', FX), 0);
});

test('holdingsCost: uses cost field (not current_price)', () => {
  // cost=50, shares=10 → 500 TWD
  assert.equal(Calc.holdingsCost([h({ cost: 50 })], 'TWD', FX), 500);
});

test('holdingsCost: USD holding displayed in TWD → fx-converted', () => {
  assert.equal(
    Calc.holdingsCost([h({ cost: 50, currency: 'USD' })], 'TWD', FX),
    500 * FX
  );
});

// --- holdingsGainLoss / holdingsGainLossPct ---

test('holdingsGainLoss: empty array → 0', () => {
  assert.equal(Calc.holdingsGainLoss([], 'TWD', FX), 0);
});

test('holdingsGainLoss: all-inactive → 0', () => {
  const records = [h({ inactive: true, shares: 10, cost: 0, current_price: 999 })];
  assert.equal(Calc.holdingsGainLoss(records, 'TWD', FX), 0);
});

test('holdingsGainLoss: positive when current_price > cost', () => {
  // 10 * (150 - 100) = 500 TWD gain
  const records = [h({ shares: 10, cost: 100, current_price: 150 })];
  assert.equal(Calc.holdingsGainLoss(records, 'TWD', FX), 500);
});

test('holdingsGainLoss: negative when current_price < cost', () => {
  const records = [h({ shares: 10, cost: 100, current_price: 80 })];
  assert.equal(Calc.holdingsGainLoss(records, 'TWD', FX), -200);
});

test('holdingsGainLoss: equals value - cost (cross-check)', () => {
  const records = [
    h({ shares: 5, cost: 80, current_price: 100, currency: 'USD' }),
  ];
  assert.equal(
    Calc.holdingsGainLoss(records, 'TWD', FX),
    Calc.holdingsValue(records, 'TWD', FX) - Calc.holdingsCost(records, 'TWD', FX)
  );
});

test('holdingsGainLossPct: returns 0 when cost is 0 (no division-by-zero)', () => {
  // cost=0 → holdingsCost=0 → pct=0 (not NaN, not Infinity)
  const records = [h({ shares: 10, cost: 0, current_price: 100 })];
  assert.equal(Calc.holdingsGainLossPct(records, 'TWD', FX), 0);
});

test('holdingsGainLossPct: positive gain → positive percent', () => {
  // gain=500, cost=1000 → 50%
  const records = [h({ shares: 10, cost: 100, current_price: 150 })];
  assert.equal(Calc.holdingsGainLossPct(records, 'TWD', FX), 50);
});

test('holdingsGainLossPct: negative gain → negative percent', () => {
  // gain=-200, cost=1000 → -20%
  const records = [h({ shares: 10, cost: 100, current_price: 80 })];
  assert.equal(Calc.holdingsGainLossPct(records, 'TWD', FX), -20);
});

// --- totalCash / totalDebts ---

test('totalCash: empty / all-inactive → 0', () => {
  assert.equal(Calc.totalCash([], 'TWD', FX), 0);
  assert.equal(Calc.totalCash([{ balance: 9999, currency: 'TWD', inactive: true }], 'TWD', FX), 0);
});

test('totalCash: single TWD account, display TWD → unchanged', () => {
  assert.equal(
    Calc.totalCash([{ balance: 50000, currency: 'TWD', inactive: false }], 'TWD', FX),
    50000
  );
});

test('totalCash: USD account displayed in TWD → fx-converted', () => {
  // 1000 USD * 32.2 = 32200 TWD
  assert.equal(
    Calc.totalCash([{ balance: 1000, currency: 'USD', inactive: false }], 'TWD', FX),
    1000 * FX
  );
});

test('totalDebts: same shape as totalCash', () => {
  assert.equal(Calc.totalDebts([], 'TWD', FX), 0);
  assert.equal(
    Calc.totalDebts([{ balance: 200, currency: 'USD', inactive: false }], 'TWD', FX),
    200 * FX
  );
});

// --- netWorth ---

test('netWorth: empty everywhere → 0', () => {
  assert.equal(Calc.netWorth([], [], [], 'TWD', FX), 0);
});

test('netWorth: holdings + cash - debts (all TWD)', () => {
  const holdings = [h({ shares: 10, current_price: 100 })];    // 1000
  const cash = [{ balance: 5000, currency: 'TWD', inactive: false }];   // 5000
  const debts = [{ balance: 2000, currency: 'TWD', inactive: false }];  // -2000
  assert.equal(Calc.netWorth(holdings, cash, debts, 'TWD', FX), 4000);
});

test('netWorth: cross-currency converted to displayCurrency', () => {
  const holdings = [h({ shares: 10, current_price: 100, currency: 'USD' })];  // 1000 USD
  const cash = [{ balance: 500, currency: 'USD', inactive: false }];          //  500 USD
  const debts = [{ balance: 200, currency: 'USD', inactive: false }];         // -200 USD
  // Net = 1300 USD, displayed in TWD = 1300 * 32.2
  assert.equal(Calc.netWorth(holdings, cash, debts, 'TWD', FX), 1300 * FX);
});

test('netWorth: ignores inactive across all three lists', () => {
  const holdings = [h({ inactive: true, shares: 10, current_price: 999 })];
  const cash = [{ balance: 5000, currency: 'TWD', inactive: true }];
  const debts = [{ balance: 9999, currency: 'TWD', inactive: true }];
  assert.equal(Calc.netWorth(holdings, cash, debts, 'TWD', FX), 0);
});

// --- gainLoss(h) per-holding (single arg, no FX) ---

test('gainLoss: shares * (current_price - cost)', () => {
  // 10 * (150 - 100) = 500
  assert.equal(Calc.gainLoss(h({ shares: 10, cost: 100, current_price: 150 })), 500);
});

test('gainLoss: negative when price dropped', () => {
  // 10 * (80 - 100) = -200
  assert.equal(Calc.gainLoss(h({ shares: 10, cost: 100, current_price: 80 })), -200);
});

test('gainLoss: zero when price equals cost', () => {
  assert.equal(Calc.gainLoss(h()), 0);
});

test('gainLoss: current_price=null treated as 0 → full loss', () => {
  // 10 * (0 - 100) = -1000  (same as inline Alpine behavior: null - cost = -cost)
  assert.equal(Calc.gainLoss(h({ current_price: null })), -1000);
});

test('gainLoss: result is in the holding\'s native currency (no FX)', () => {
  // Same math regardless of USD or TWD — gainLoss doesn't know about fx.
  const usd = Calc.gainLoss(h({ shares: 10, cost: 100, current_price: 150, currency: 'USD' }));
  const twd = Calc.gainLoss(h({ shares: 10, cost: 100, current_price: 150, currency: 'TWD' }));
  assert.equal(usd, twd);
});

// --- activeCount (generic) ---

test('activeCount: empty array → 0', () => {
  assert.equal(Calc.activeCount([]), 0);
});

test('activeCount: counts items where inactive is falsy', () => {
  // 5 active, 2 inactive → 5
  const records = [
    { inactive: false },
    { inactive: false },
    { inactive: false },
    { inactive: false },
    { inactive: false },
    { inactive: true },
    { inactive: true },
  ];
  assert.equal(Calc.activeCount(records), 5);
});

test('activeCount: missing inactive field treated as active', () => {
  // Records fresh out of the editor before the toggle is set still count.
  assert.equal(Calc.activeCount([{}, {}, { inactive: true }]), 2);
});

test('activeCount: works for cash_accounts and debts (same shape)', () => {
  const cash = [
    { balance: 1, currency: 'TWD', inactive: false },
    { balance: 2, currency: 'TWD', inactive: true },
  ];
  const debts = [
    { balance: 3, currency: 'TWD', inactive: false },
    { balance: 4, currency: 'TWD', inactive: false },
    { balance: 5, currency: 'TWD', inactive: false },
  ];
  assert.equal(Calc.activeCount(cash), 1);
  assert.equal(Calc.activeCount(debts), 3);
});