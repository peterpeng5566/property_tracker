# Research: categories, exposure terminology, default/active patterns

Repo: `/home/peter/ios/property_tracker_web`. Investigated three facts about the existing data model to inform a possible new "exposure" or numeric category feature.

---

## 1. Existing categories — kinds and shape

**Schema** — categories live in `data.categories[]`, each entry has:

```js
// portfolio.html:3680-3683
function defaultCategory() {
  return { id: '', name: 'New Category', values: [], applies_to: ['holdings', 'cash', 'debt'] };
}
```

Each value is `{ id: string, name: string }` — i.e. a free-form named enum, not a number. Records reference a value by `record.attributes[catId] = valueId` (see §3).

**Kind of category — enum-valued only.** Every real fixture in the repo uses enum/string values. There are no numeric-valued, multiplier, percentage, or ratio categories anywhere.

Empty-state placeholder names enum categories explicitly:

```js
// portfolio.html:3045
'categories.empty': 'No categories yet. e.g., Sector, Market, Region.',
```

`CONTEXT.md` reinforces the same scope:

> **Category**: A defined attribute type, e.g. `Sector` or `Market`. Has a name, a list of values, and an `applies_to` set declaring which record types it can be attached to.

### Real fixture examples (all enum-valued)

`tests/plan.test.js:54-66` — the canonical fixtures used by the unit tests:

```js
const COUNTRY_CAT = {
  id: 'country',
  name: 'Country',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'TW', name: '台灣' },
    { id: 'US', name: 'United States' },
  ],
};
const TYPE_CAT = {
  id: 'type',
  name: 'Type',
  applies_to: ['holding', 'cash', 'debt'],
  values: [
    { id: 'stock', name: 'Stock' },
    { id: 'bond', name: 'Bond' },
  ],
};
```

`tests/browser/plan-flow.spec.js:51-56` — Region/Type naming (matches the empty-state hint):

```js
categories: [
  { id: 'cat-region', name: 'Region', applies_to: ['holdings','cash','debt'],
    values: [{ id: 'val-TW', name: 'TW' }, { id: 'val-US', name: 'US' }] },
  { id: 'cat-type', name: 'Type', applies_to: ['holdings','cash','debt'],
    values: [{ id: 'val-stock', name: 'Stock' }, { id: 'val-bond', name: 'Bond' }] },
],
```

`tests/browser/rebalance.spec.js:47-52`, `tests/browser/categories-guard.spec.js:45-50` — identical Region/Type pair.

`tests/browser/snapshots.spec.js:295-303` — Country fixture used in detail-page tests:

```js
categories: [
  {
    id: 'cat-country',
    name: 'Country',
    applies_to: ['holdings', 'cash', 'debt'],
    values: [
      { id: 'val-us', name: 'US' },
      { id: 'val-tw', name: 'TW' },
    ],
  },
],
```

`tests/sync.test.js` uses synthetic categories for the merge tests (`'finance'`, `'tech'`, `'Magic-Cat'`, `'h1'`, etc.) — none of them numeric either.

### What this means for an "exposure" feature

Every existing category is a *string-enum attribute* used for grouping. The codebase has no precedent for:
- numeric categories (`1x`, `2x`, `…`)
- percentage / weight categories
- ratio categories
- multiplier categories

Any such feature would be a new shape, not an extension of the existing one. `Sector / Market / Region / Country / Type` is the full set of enum category *names* that appear in fixtures and copy.

---

## 2. Exposure / leverage / notional / margin — does the term already exist?

Ran from repo root, skipping `node_modules` and `.git`:

```
grep -rni "exposure\|leverage\|notional\|margin" --include='*.js' --include='*.html' --include='*.md' .
```

Full result (18 matches across 11 files):

| File:line | Context (2-3 lines) | Meaning |
|---|---|---|
| `.scratch/v1.9-mobile-responsiveness/issues/02-mobile-fixes.md:29` | `> Highest exposure: every page renders the header.` | UI surface area (informal) |
| `.scratch/v1.11-known-limitations/issues/01-taiwan-etf-yahoo-429.md:25` | `The 3 known-affected symbols are all **TWSE-listed leveraged bond` | Refers to a real `leveraged` bond-ETF product class; not a feature term |
| `.scratch/v1/issues/01-web-local-storage.md:46` | `**Q1 確認**（直到這題 grill 完才發現這是 leverage 問題）：` | Chinese-language note using "leverage" metaphorically ("the leverage of the problem") |
| `docs/research/04-option-f-service-worker-cors-feasibility.md:13` | `… main fetch wraps the non-filtered response as a "CORS filtered response" (header exposure filter, NOT a pass/fail check):` | Fetch-spec jargon — "response header exposure", unrelated |
| `docs/research/04-option-f-service-worker-cors-feasibility.md:56` | `… the response is then wrapped as a "CORS filtered response" — but this is a *header exposure* filter, not a pass/fail check:` | Same — Fetch spec jargon |
| `docs/adr/0022-refresh-toast.md:81` | `… Adds a new UI element for marginal gain over the toast.` | "marginal" = incremental benefit (informal) |
| `docs/adr/0006-multi-page-web-architecture.md:80` | `- Tab bar adds vertical real estate (marginal cost)` | "marginal" = incremental cost (informal) |
| `docs/adr/0014-snapshot-ui.md:75` | `… ternary compare picker (over-selection handling unclear), or block same-snapshot …` | "marginal" / over-selection — informal |
| `docs/adr/0020-mobile-responsiveness.md:105` | `- **Snapshot trend chart** SVG (`viewBox` based) renders correctly at 414 px but loses the right-side margin around the polyline.` | CSS / SVG plot geometry |
| `.scratch/v1.9-mobile-responsiveness/map.md:206` | `- **Snapshot trend chart** SVG: `viewBox` scaling works but right-side margin lost; would need viewport-specific padding (audit note Q18).` | CSS / SVG plot geometry |
| `.scratch/v1.5-snapshot-ui/issues/05-trend-chart-sparkline.md:64` | `  - `chartPlotBounds()`, `_chartX(i, n)`, `_chartY(value, domain)` — SVG geometry helpers using viewBox 800×200 with left/right/top/bottom margins.` | Code comment — SVG plot geometry |
| `portfolio.html:155` | `      margin-right: 0.25rem;` | CSS |
| `portfolio.html:5030` | `      // (margin, plot width/height) live inside chartPlotBounds() so` | Code comment — SVG plot geometry |
| `portfolio.html:5042-5045` | `      _CHART_MARGIN_LEFT: 60,` / `_CHART_MARGIN_RIGHT: 20,` / `_CHART_MARGIN_TOP: 10,` / `_CHART_MARGIN_BOTTOM: 50, // reserves room for x-hint + legend` | SVG chart bounds |
| `portfolio.html:5074-5077` | `          x0: this._CHART_MARGIN_LEFT,` / `x1: this._CHART_VIEW_W - this._CHART_MARGIN_RIGHT,` / `y0: this._CHART_MARGIN_TOP,` / `y1: this._CHART_VIEW_H - this._CHART_MARGIN_BOTTOM,` | SVG chart bounds |
| `tests/browser/_sync_auto_pull.spec.js:215` | `    // network is ~500 ms; we give 1.5× margin.` | Test timing-buffer comment (informal) |

### Verdict

**No financial sense of "exposure", "leverage", "notional", or "margin" exists anywhere in the codebase.** Every match is either CSS/SVG geometry, a comment about UI surface area, the Fetch-spec "header exposure" filter, or an unrelated reference to real-world leveraged bond ETFs / Chinese-language commentary. The strings are unused and free to be claimed by a new feature.

---

## 3. Default / "active" category pattern

### There is no `default_category_id` / `active_category_id` / `primary_category_id` pattern.

Search across the repo:

```
grep -rni "default.categor\|default.cat\|active.categor\|primary.categor" --include='*.js' --include='*.html' --include='*.md' .
```

→ **no matches.** Categories are referenced purely by their `id`; the code has no notion of "the default category" or "the active category".

The only active-pointer pattern in the data model is **`data.active_plan_id`** (for Plans). It's stored alongside `data.plans[]` and the user picks one plan to be the drift source. Quotes:

```js
// portfolio.html:3670-3677 — declaration in defaultPortfolio()
      // v1.4: Plan list + active-plan pointer. Plans are settings (not
      // portfolio state) — see .scratch/v1.4-target-allocation-plans/
      // and the planned v1.4 ADR (ticket 06). `active_plan_id` is null
      // when no plan is active; the Home drift report hides itself when
      // null. Both fields are additive (no version bump).
      plans: [],
      active_plan_id: null,
```

```js
// lib/plan.js:219-237 — validation + lookup at runtime
  // Whole-portfolio validation. The contract: `data.active_plan_id` is
  // a soft pointer (sync can race it ahead of plan deletions on another
  // device) — we WARN rather than reject so the app keeps running and
  // the UI can offer to either clear the pointer or restore the plan.
  function validatePlans(data) {
    const errors = [];
    const warnings = [];
    const plans = (data && data.plans) || [];
    const activePlanId = data && data.active_plan_id;
    if (activePlanId !== null && activePlanId !== undefined && activePlanId !== '') {
      const exists = plans.some(p => p && p.id === activePlanId);
      if (!exists) {
        warnings.push(`active_plan_id "${activePlanId}" does not reference any existing plan`);
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }
```

```js
// portfolio.html:6018 — runtime read at the Home drift page
        const id = this.data.active_plan_id;
```

```js
// lib/sync.js:91-100 — scalar merge semantics for sync
    // active_plan_id (v1.4 — ticket 05): a scalar pointer with no
    // per-record merge — last-writer-wins by remote timestamp.
    const activePlanId = remote.active_plan_id !== undefined
      ? remote.active_plan_id
      : (local.active_plan_id !== undefined ? local.active_plan_id : null);
```

There is no analogous field for categories.

### Storage location of category assignment (per-record)

Categories are attached to records one value at a time via `record.attributes[catId] = valueId`. Three modal-flavoured code paths mirror each other:

**Holdings modal** (`portfolio.html:2597-2612`):

```html
        <!-- Attributes -->
        <div x-show="categoriesForHoldings.length > 0" class="border-t border-slate-100 pt-4">
          <label class="block text-sm font-medium text-slate-700 mb-2" x-text="t('modal.attributes')"></label>
          <div class="space-y-3">
            <template x-for="cat in categoriesForHoldings" :key="cat.id">
              <div>
                <label class="block text-xs text-slate-500 mb-1" x-text="cat.name"></label>
                <select @change="setFormAttribute(cat.id, $event.target.value)"
                        class="w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="" :selected="!form.attributes[cat.id]">—</option>
                  <template x-for="val in cat.values" :key="val.id">
                    <option :value="val.id" :selected="form.attributes[cat.id] === val.id" x-text="val.name"></option>
                  </template>
                </select>
              </div>
            </template>
          </div>
        </div>
```

Cash modal (`portfolio.html:2650-2667`) and Debt modal (`portfolio.html:2703-2717`) use `cashForm.attributes` / `debtForm.attributes` and the matching `setCashFormAttribute` / `setDebtFormAttribute` handlers.

**Runtime write path** (`portfolio.html:4769-4772`):

```js
      setFormAttribute(catId, valId) {
        if (valId) this.form.attributes[catId] = valId;
        else delete this.form.attributes[catId];
      },
```

The cash/debt counterparts are at `portfolio.html:5479-5481` and `5533-5535` with identical bodies but on `cashForm.attributes` / `debtForm.attributes`.

**Commit to record** (`portfolio.html:4773-4786`):

```js
      saveHolding() {
        const now = new Date().toISOString();
        const id = this.editing ? this.editing.id : genId('h');
        const attributes = {};
        for (const [catId, valId] of Object.entries(this.form.attributes || {})) {
          if (valId) attributes[catId] = valId;
        }
        const record = {
          id, ticker: this.form.ticker.toUpperCase().trim(),
          shares: this.form.shares, cost: this.form.cost,
          currency: this.form.currency, current_price: this.form.current_price,
          // v1.1: 52W high/low + previous close. Null until refreshed.
          high_52w: this.editing?.high_52w ?? null,
          low_52w: this.editing?.low_52w ?? null,
          prev_close: this.editing?.prev_close ?? null,
          attributes, updated_at: now, device_id: DEVICE_ID,
          inactive: this.editing ? this.editing.inactive : false,
```

So a holding ends up with `record.attributes` shaped like `{ 'cat-region': 'val-TW', 'cat-type': 'val-stock' }` — a flat `catId → valueId` map.

**Read path used by the lib** — `lib/plan.js` consumes this via the parallel `recordsAttributes` lookup (the Alpine shim assembles it from each record's `attributes` field) — see `lib/plan.js:18-19` and `recordsMatchingRule` at lines 254-281.

**Which categories surface where** (`portfolio.html:4735-4743`):

```js
      get categoriesForHoldings() {
        return this.data.categories.filter(c => c.applies_to?.includes('holdings'));
      },
      get categoriesForCash() {
        return this.data.categories.filter(c => c.applies_to?.includes('cash'));
      },
      get categoriesForDebts() {
        return this.data.categories.filter(c => c.applies_to?.includes('debt'));
      },
```

A category with empty `applies_to` never appears in any modal — the empty-state copy warns about it (`portfolio.html:3050`).

### Verdict

The codebase has one active-pointer field — `data.active_plan_id` — and **no analogous default/active pointer for categories**. Categories are pure-data records; the active concept lives only at the Plan layer. There is no storage location to read from if you're looking for "the default category", because none exists.

---

## Open questions

None. All three questions were answered against primary sources:
- Categories → schema in `portfolio.html:3680-3683`, fixtures in `tests/plan.test.js:54-66`, `tests/browser/plan-flow.spec.js:51-56`, `tests/browser/rebalance.spec.js:47-52`, `tests/browser/categories-guard.spec.js:45-50`, `tests/browser/snapshots.spec.js:295-303`; terminology defined in `CONTEXT.md:79-83`.
- Exposure / leverage / notional / margin → full grep output above; zero financial matches.
- Default / active pattern → confirmed no `default_category_id` / `active_category_id` exists anywhere; the only active-pointer is `data.active_plan_id` (declaration `portfolio.html:3670-3677`, validation `lib/plan.js:219-237`, runtime read `portfolio.html:6018`, sync `lib/sync.js:91-100`).
