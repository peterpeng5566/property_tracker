// tests/snapshot-chart.test.js — tests for lib/snapshot-chart.js (v1.22)
//
// Source of truth: lib/snapshot-chart.js + spec.md in
// .scratch/v1.22-snapshot-chart-lib/.
//
// Pure SVG geometry extracted from portfolio.html:5177–5420 (v1.5 T05).
// Each test maps to one of the 7 exported functions:
//   chartLayout, chartDomain, chartPoints, chartDots,
//   chartDotMarkup, chartAxisMarkup, escapeXml
//
// _chartX / _chartY are internal helpers (not exported) but their
// behavior is verified transitively via chartPoints and chartDots.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SnapshotChart = require('../lib/snapshot-chart.js');
const {
  chartLayout,
  chartDomain,
  chartPoints,
  chartDots,
  chartDotMarkup,
  chartAxisMarkup,
  escapeXml,
} = SnapshotChart;

// Convenience fixtures.
const layout = chartLayout();

// Three-point series: ascending netWorth + holdingsValue.
const series3 = [
  { id: 'a', date: '2025-01-01', netWorth: 100, holdingsValue: 100 },
  { id: 'b', date: '2025-01-15', netWorth: 200, holdingsValue: 100 },
  { id: 'c', date: '2025-02-01', netWorth: 300, holdingsValue: 100 },
];

// Single-point series where netWorth === holdingsValue (so domain
// padding yields clean mid-y values: y = 80).
const singleSeries = [
  { id: 'a', date: '2025-01-01', netWorth: 100, holdingsValue: 100 },
];

// All-equal series (range = 0) — exercises the no-NaN guard.
const flatSeries = [
  { id: 'a', date: '2025-01-01', netWorth: 50, holdingsValue: 50 },
  { id: 'b', date: '2025-01-15', netWorth: 50, holdingsValue: 50 },
];

// Parse "x,y x,y ..." into [[x, y], ...]. Used for structural
// assertions on polyline strings.
const parsePoints = (str) => str.split(' ').filter(Boolean).map(p => p.split(',').map(Number));

// =========================================================================
// chartLayout
// =========================================================================

test('chartLayout: default bounds are 800x200 viewBox minus margins', () => {
  // CHART_VIEW_W=800, CHART_MARGIN_LEFT=60, CHART_MARGIN_RIGHT=20 → x0=60, x1=780
  // CHART_VIEW_H=200, CHART_MARGIN_TOP=10, CHART_MARGIN_BOTTOM=50 → y0=10, y1=150
  assert.deepEqual(layout, { x0: 60, x1: 780, y0: 10, y1: 150 });
});

// =========================================================================
// chartDomain
// =========================================================================

test('chartDomain: empty series → 0/0/0', () => {
  assert.deepEqual(chartDomain([]), { min: 0, mid: 0, max: 0 });
});

test('chartDomain: undefined / non-array → 0/0/0 (defensive)', () => {
  assert.deepEqual(chartDomain(undefined), { min: 0, mid: 0, max: 0 });
  assert.deepEqual(chartDomain(null), { min: 0, mid: 0, max: 0 });
});

test('chartDomain: 3 ascending points → padded min/max by 8%, mid = average', () => {
  // series3 min=100, max=300 (netWorth range; holdingsValue=100 doesn't widen).
  // range = 200; pad = 16; min = 84, max = 316, mid = 200
  const d = chartDomain(series3);
  assert.equal(d.min, 84);
  assert.equal(d.max, 316);
  assert.equal(d.mid, 200);
});

test('chartDomain: all-equal values do not produce NaN', () => {
  // range = 0; fallback range = max(|50|, 1) = 50; pad = 4
  // min = 46, max = 54, mid = 50
  const d = chartDomain(flatSeries);
  assert.ok(Number.isFinite(d.min));
  assert.ok(Number.isFinite(d.mid));
  assert.ok(Number.isFinite(d.max));
  assert.equal(d.min, 46);
  assert.equal(d.max, 54);
  assert.equal(d.mid, 50);
});

test('chartDomain: single point still pads (uses fallback range guard)', () => {
  // range = 0; fallback range = max(|100|, 1) = 100; pad = 8
  // min = 92, max = 108, mid = 100
  const d = chartDomain(singleSeries);
  assert.equal(d.min, 92);
  assert.equal(d.max, 108);
  assert.equal(d.mid, 100);
});

// =========================================================================
// chartPoints
// =========================================================================

test('chartPoints: 3 points → netWorth polyline with evenly distributed x and monotonic y', () => {
  const d = chartDomain(series3);
  const pts = chartPoints(series3, layout, d);
  const coords = parsePoints(pts.netWorth);
  assert.equal(coords.length, 3);
  // x coords: 60, 420, 780 (clean: layout.x0, midpoint, layout.x1)
  assert.equal(coords[0][0], 60);
  assert.equal(coords[1][0], 420);
  assert.equal(coords[2][0], 780);
  // y coords: ascending input → descending y (SVG flip)
  assert.ok(coords[0][1] > coords[1][1], `expected y[0] > y[1], got ${coords[0][1]} vs ${coords[1][1]}`);
  assert.ok(coords[1][1] > coords[2][1], `expected y[1] > y[2], got ${coords[1][1]} vs ${coords[2][1]}`);
  // all y within plot bounds
  for (const [, y] of coords) {
    assert.ok(y >= layout.y0 && y <= layout.y1, `y=${y} not in [${layout.y0}, ${layout.y1}]`);
  }
});

test('chartPoints: 3 points → holdings polyline non-empty and structurally valid', () => {
  const d = chartDomain(series3);
  const pts = chartPoints(series3, layout, d);
  assert.notEqual(pts.holdings, '');
  const coords = parsePoints(pts.holdings);
  assert.equal(coords.length, 3);
  // x coords match the netWorth polyline (same series index → same x).
  assert.equal(coords[0][0], 60);
  assert.equal(coords[1][0], 420);
  assert.equal(coords[2][0], 780);
});

test('chartPoints: empty series → both polylines are empty strings', () => {
  const d = chartDomain([]);
  const pts = chartPoints([], layout, d);
  assert.equal(pts.netWorth, '');
  assert.equal(pts.holdings, '');
});

test('chartPoints: single point → netWorth collapses to centre, holdings hidden', () => {
  // n=1 → _chartX returns (60+780)/2 = 420; netWorth=100 at domain.mid=100 → y=80
  // holdings line hidden for n<2
  const d = chartDomain(singleSeries);
  const pts = chartPoints(singleSeries, layout, d);
  assert.equal(pts.netWorth, '420,80');
  assert.equal(pts.holdings, '');
});

// =========================================================================
// chartDots
// =========================================================================

test('chartDots: 3 points → netWorth + holdings arrays, each with 3 entries', () => {
  const d = chartDomain(series3);
  const dots = chartDots(series3, layout, d);
  assert.equal(dots.netWorth.length, 3);
  assert.equal(dots.holdings.length, 3);
  // Each dot carries id, date, cx, cy, value.
  for (const dot of dots.netWorth) {
    assert.ok(typeof dot.id === 'string');
    assert.ok(typeof dot.date === 'string');
    assert.equal(typeof dot.cx, 'number');
    assert.equal(typeof dot.cy, 'number');
    assert.equal(typeof dot.value, 'number');
  }
});

test('chartDots: empty series → both arrays empty', () => {
  const d = chartDomain([]);
  const dots = chartDots([], layout, d);
  assert.deepEqual(dots.netWorth, []);
  assert.deepEqual(dots.holdings, []);
});

test('chartDots: single point → holdings is empty (n<2 hidden)', () => {
  const d = chartDomain(singleSeries);
  const dots = chartDots(singleSeries, layout, d);
  assert.equal(dots.netWorth.length, 1);
  assert.equal(dots.netWorth[0].cx, 420);  // centre x
  assert.equal(dots.netWorth[0].cy, 80);   // mid y
  assert.deepEqual(dots.holdings, []);
});

// =========================================================================
// chartDotMarkup
// =========================================================================

test('chartDotMarkup: empty dots → empty string', () => {
  assert.equal(chartDotMarkup([], { fillColor: '#000', radius: 3 }), '');
});

test('chartDotMarkup: each dot wrapped in <g data-snap-id=...> for event delegation', () => {
  const d = chartDomain(series3);
  const dots = chartDots(series3, layout, d).netWorth;
  const markup = chartDotMarkup(dots, { fillColor: '#0f172a', radius: 3, formatAmount: (v) => '$' + v });
  for (const dot of dots) {
    assert.ok(markup.includes(`data-snap-id="${dot.id}"`), `missing data-snap-id for ${dot.id}`);
  }
});

test('chartDotMarkup: each dot has <title> tooltip with formatted date and value', () => {
  const d = chartDomain(series3);
  const dots = chartDots(series3, layout, d).netWorth;
  const markup = chartDotMarkup(dots, {
    fillColor: '#0f172a', radius: 3,
    formatAmount: (v) => '$' + v,
  });
  // First dot: date '2025-01-01', value 100 → tooltip '$100'
  assert.ok(markup.includes('<title>2025-01-01 · $100</title>'));
});

// =========================================================================
// chartAxisMarkup
// =========================================================================

test('chartAxisMarkup: produces 3 ticks, each tick = 1 <line> + 1 <text> (6 SVG children total)', () => {
  const d = chartDomain(series3);
  const markup = chartAxisMarkup(layout, d, (v) => '$' + v);
  // Count <line> and <text> substrings.
  const lineCount = (markup.match(/<line\b/g) || []).length;
  const textCount = (markup.match(/<text\b/g) || []).length;
  assert.equal(lineCount, 3);
  assert.equal(textCount, 3);
});

test('chartAxisMarkup: tick labels formatted via injected formatAmount callback', () => {
  const d = chartDomain(series3);
  // series3 domain: min=84, mid=200, max=316
  const markup = chartAxisMarkup(layout, d, (v) => '[' + v + ']');
  assert.ok(markup.includes('[84]'));
  assert.ok(markup.includes('[200]'));
  assert.ok(markup.includes('[316]'));
});

// =========================================================================
// escapeXml
// =========================================================================

test('escapeXml: ampersand escaped first (to avoid double-escaping later chars)', () => {
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('A & B'), 'A &amp; B');
});

test('escapeXml: less-than → &lt;', () => {
  assert.equal(escapeXml('<script>'), '&lt;script&gt;');
});

test('escapeXml: greater-than → &gt;', () => {
  assert.equal(escapeXml('a > b'), 'a &gt; b');
});

test('escapeXml: double-quote → &quot;', () => {
  assert.equal(escapeXml('"hi"'), '&quot;hi&quot;');
});

test('escapeXml: safe characters pass through unchanged', () => {
  assert.equal(escapeXml('hello-world_42.txt'), 'hello-world_42.txt');
  assert.equal(escapeXml(''), '');
  assert.equal(escapeXml(123), '123'); // coerces to string
});
