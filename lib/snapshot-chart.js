// lib/snapshot-chart.js — pure SVG geometry for the snapshot trend chart.
//
// Source of truth for the chart math that used to live in
// portfolio.html:5177–5420 (v1.5 ticket 05). The Alpine shim is now
// a thin pass-through; this module owns the geometry and is unit-
// testable via node:test (tests/snapshot-chart.test.js).
//
// Output is SVG markup strings injected via x-html because Alpine 3's
// <template x-for> doesn't propagate the iterator scope to children
// inside an SVG namespace. Strings are pure (no Alpine, no DOM
// access) and have no dependencies beyond Format.* (already used by
// lib/snapshot.js for toDisplaySeries).
//
// Loaded by portfolio.html via <script src="lib/snapshot-chart.js">
// (browser globals). Also imported by tests/snapshot-chart.test.js
// for Node.js testing (CommonJS).
//
// API:
//   chartLayout()                            → { x0, x1, y0, y1 }
//   chartDomain(series)                      → { min, mid, max }
//   chartPoints(series, layout, domain)      → { netWorth: string, holdings: string }
//   chartDots(series, layout, domain)        → { netWorth: [{id, date, cx, cy, value}], holdings: [...] }
//   chartDotMarkup(dots, opts)               → string  (generic; netWorth/holdings differ only by opts)
//   chartAxisMarkup(layout, domain, formatAmount) → string
//   escapeXml(str)                           → string

(function (root) {
  'use strict';

  // ViewBox + margin constants. Single source of truth for the chart's
  // plot area; the template's <svg viewBox="0 0 800 200"> is a
  // separate concern (SVG attribute) — duplication of 800/200 across
  // the lib and the template is acceptable.
  const VIEW_W = 800;
  const VIEW_H = 200;
  const MARGIN_LEFT = 60;
  const MARGIN_RIGHT = 20;
  const MARGIN_TOP = 10;
  const MARGIN_BOTTOM = 50;

  // Domain padding (8% of range, top + bottom). Same value as the
  // previous in-shim implementation. Ensures the polyline doesn't
  // touch the top/bottom edges of the plot area.
  const DOMAIN_PADDING = 0.08;

  // chartLayout: SVG plot-area bounds in viewBox coordinates. Used by
  // every other helper that needs to project a value to (x, y).
  function chartLayout() {
    return {
      x0: MARGIN_LEFT,
      x1: VIEW_W - MARGIN_RIGHT,
      y0: MARGIN_TOP,
      y1: VIEW_H - MARGIN_BOTTOM,
    };
  }

  // chartDomain: returns {min, mid, max} across BOTH netWorth and
  // holdingsValue so the shared y-axis covers both polylines. Empty
  // / non-array input → 0/0/0. Range is padded 8% top + bottom. When
  // range = 0 (all values equal), the fallback range is
  // max(|max|, 1) so the padding is non-zero and the polyline has
  // somewhere to sit.
  function chartDomain(series) {
    const arr = Array.isArray(series) ? series : [];
    if (arr.length === 0) return { min: 0, mid: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const s of arr) {
      if (s.netWorth < min) min = s.netWorth;
      if (s.netWorth > max) max = s.netWorth;
      if (s.holdingsValue < min) min = s.holdingsValue;
      if (s.holdingsValue > max) max = s.holdingsValue;
    }
    const range = (max - min) || Math.max(Math.abs(max), 1);
    const pad = range * DOMAIN_PADDING;
    min = min - pad;
    max = max + pad;
    return { min, mid: (min + max) / 2, max };
  }

  // _chartX: x coordinate for index `i` of `n` total points. n=1 →
  // horizontal centre (single-point collapse), matching the previous
  // in-shim behavior.
  function _chartX(i, n, layout) {
    if (n <= 1) return (layout.x0 + layout.x1) / 2;
    return layout.x0 + ((layout.x1 - layout.x0) * i) / (n - 1);
  }

  // _chartY: y coordinate for `value` in [domain.min, domain.max].
  // y axis flipped (SVG top = small y). Degenerate domain
  // (max === min) → vertical centre.
  function _chartY(value, domain, layout) {
    if (domain.max === domain.min) return (layout.y0 + layout.y1) / 2;
    const t = (value - domain.min) / (domain.max - domain.min);
    return layout.y1 - t * (layout.y1 - layout.y0);
  }

  // chartPoints: returns polyline point strings for netWorth and
  // holdings. Empty series → both ''. Single point → netWorth
  // collapses to a single x,y; holdings is '' (holdings line is
  // hidden for n<2, same as the previous in-shim behavior).
  function chartPoints(series, layout, domain) {
    const arr = Array.isArray(series) ? series : [];
    if (arr.length === 0) return { netWorth: '', holdings: '' };
    const n = arr.length;
    const netWorth = arr.map((s, i) =>
      `${_chartX(i, n, layout)},${_chartY(s.netWorth, domain, layout)}`
    ).join(' ');
    const holdings = n < 2 ? '' : arr.map((s, i) =>
      `${_chartX(i, n, layout)},${_chartY(s.holdingsValue, domain, layout)}`
    ).join(' ');
    return { netWorth, holdings };
  }

  // chartDots: returns arrays of dot data for both polylines. Each
  // entry is {id, date, cx, cy, value} — everything the markup
  // helper needs. Single point → holdings is [] (n<2 hidden).
  function chartDots(series, layout, domain) {
    const arr = Array.isArray(series) ? series : [];
    if (arr.length === 0) return { netWorth: [], holdings: [] };
    const n = arr.length;
    const netWorth = arr.map((s, i) => ({
      id: s.id,
      date: s.date,
      cx: _chartX(i, n, layout),
      cy: _chartY(s.netWorth, domain, layout),
      value: s.netWorth,
    }));
    const holdings = n < 2 ? [] : arr.map((s, i) => ({
      id: s.id,
      date: s.date,
      cx: _chartX(i, n, layout),
      cy: _chartY(s.holdingsValue, domain, layout),
      value: s.holdingsValue,
    }));
    return { netWorth, holdings };
  }

  // chartDotMarkup: SVG markup for one polyline's worth of dots.
  // Generic: netWorth calls this with (fill #0f172a, radius 3);
  // holdings calls it with (fill #10b981, opacity 0.7, radius 2.5).
  // Each dot renders as a <g> with two <circle>s: a transparent
  // r=10 hit area (carrying the browser-native <title> tooltip) and
  // the visible dot at the configured radius. `data-snap-id`
  // enables Alpine event delegation in the shim (chartDotClick /
  // chartDotEnter / chartDotLeave).
  //
  // opts: { fillColor, radius, opacity?, formatAmount }
  function chartDotMarkup(dots, opts) {
    const arr = Array.isArray(dots) ? dots : [];
    if (arr.length === 0) return '';
    const o = opts || {};
    const fill = o.fillColor || '#0f172a';
    const radius = o.radius || 3;
    const opacityAttr = (o.opacity != null) ? ` opacity="${o.opacity}"` : '';
    const formatAmount = o.formatAmount || ((v) => String(v));
    return arr.map(d => {
      const cx = Number(d.cx) || 0;
      const cy = Number(d.cy) || 0;
      const tip = escapeXml(d.date + ' · ' + formatAmount(d.value));
      return (
        `<g data-snap-id="${escapeXml(d.id)}" class="chart-dot" style="cursor:pointer">`
        + `<circle cx="${cx}" cy="${cy}" r="10" fill="transparent">`
        + `<title>${tip}</title></circle>`
        + `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}"${opacityAttr} />`
        + `</g>`
      );
    }).join('');
  }

  // chartAxisMarkup: SVG markup for the y-axis. Three ticks
  // (min / mid / max), each a horizontal dashed <line> + a
  // right-anchored <text> label. Text is formatted by the injected
  // `formatAmount` callback (Format.formatAmount in production; a
  // stub in tests where exact label text doesn't matter).
  function chartAxisMarkup(layout, domain, formatAmount) {
    const fmt = formatAmount || ((v) => String(v));
    const yMin = _chartY(domain.min, domain, layout);
    const yMid = _chartY(domain.mid, domain, layout);
    const yMax = _chartY(domain.max, domain, layout);
    const labelX = layout.x0 - 8;
    const ticks = [
      { y: yMax, text: fmt(domain.max) },
      { y: yMid, text: fmt(domain.mid) },
      { y: yMin, text: fmt(domain.min) },
    ];
    return ticks.map(t => {
      const yNum = Number(t.y) || 0;
      const text = escapeXml(t.text);
      return (
        `<line x1="${layout.x0}" x2="${layout.x1}" y1="${yNum}" y2="${yNum}" `
        + `stroke="#e2e8f0" stroke-width="0.5" stroke-dasharray="2 3" />`
        + `<text x="${labelX}" y="${yNum}" dominant-baseline="middle" `
        + `font-size="10" fill="#64748b" text-anchor="end">${text}</text>`
      );
    }).join('');
  }

  // escapeXml: minimal XML/HTML attribute + text escape. Covers the
  // four characters the chart markup produces (&, <, >, "). Single-
  // pass string replacement; pure. The ampersand is replaced first
  // so subsequent replacements don't double-escape it.
  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const api = {
    chartLayout,
    chartDomain,
    chartPoints,
    chartDots,
    chartDotMarkup,
    chartAxisMarkup,
    escapeXml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SnapshotChart = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
