# 0006 — Multi-page Web architecture with top tab bar

## Status

Accepted (v0.5)

## Context

Through v0.4, the Web app is a single scrolling page showing:
- 4 summary cards (Net Worth / Holdings / Cash / Debts)
- Holdings table
- Cash table
- Debts table
- Categories CRUD
- Group by Category (per-category, with 3 sub-tables)
- Debug panel

At ~1200 lines of HTML in a single file, this is still manageable but has problems:

1. **Long scroll**. The user must scroll past every section to reach Categories at the bottom.
2. **Category ambiguity**. A category like `Sector` is shown in Holdings modal, Cash modal, and Debt modal — even though `Sector` only makes sense for stock holdings. The user has to mentally filter.
3. **Cognitive overload**. Opening the app shows everything at once. There's no natural "where am I" anchor.

The user wants:
- Different sections (Holdings, Cash & Debts, Categories) on different pages
- Homepage = total net worth + group by category (read-only summary)
- Categories to declare which record types they apply to

## Decision

### Architecture

Four pages, top tab bar navigation, in-memory state (no URL routing):

| Page | Content |
|------|---------|
| Home | 4 summary cards + Group by Category (filtered) + Debug |
| Holdings | Holdings table + Add/Edit modal |
| Cash & Debts | Cash table + Debts table (stacked) + 2 modals |
| Categories | Categories CRUD (inline editing, no modal) |

State held in single Alpine factory (`currentPage: 'home' | 'holdings' | 'cash_debt' | 'categories'`). No `history.pushState`, no hash routing. State resets on full page reload (intentional — only reloads are full app reloads).

### Category applies-to

Categories gain an `applies_to: string[]` field. Valid values:
- `'holdings'` — for stock-related categories (Sector, Industry, Ticker Notes)
- `'cash'` — for cash account categories (Bank, Account Type)
- `'debt'` — for debt categories (Loan Type, Lender)
- Combinations allowed: `['holdings', 'cash']` (e.g., Region)

Filtering rules:
- Holdings modal shows only categories where `applies_to.includes('holdings')`
- Cash modal shows only categories where `applies_to.includes('cash')`
- Debt modal shows only categories where `applies_to.includes('debt')`
- Group by Category shows only sub-tables for record types in `applies_to` (a `['holdings']` category shows Holdings sub-table only)

Migration: categories without `applies_to` from v0.4 default to `['holdings']` (most common intent).
New categories default to `['holdings', 'cash', 'debt']` (most permissive — user narrows).

### UI for applies_to

Three toggle pills per category in the Categories page:
- `[ Holdings ]` `[ Cash ]` `[ Debt ]`
- Lit = included in `applies_to`, dimmed = not
- Empty `applies_to` shows warning: "This category won't appear in any modal"

## Consequences

### Positive

- Each page focused on one concern
- Categories self-declare their scope, no UI pollution
- Group by on Home only shows relevant sub-tables (no empty "Sector" for Cash)
- Scales: adding Settings / Reports / Snapshots pages is just another tab

### Negative

- In-memory page state — refresh resets to Home (acceptable for personal app, no shared links expected)
- Tab bar adds vertical real estate (marginal cost)
- Categories page can grow many cards; might need filtering by type later

### Trade-offs accepted

- **No URL routing**: saves complexity; user doesn't bookmark sub-pages
- **No nested sub-tabs** within Cash & Debts page (chosen a — stacked): if one becomes much larger than the other, revisit

## Alternatives considered

- **Sidebar nav**: takes horizontal space, less aligned with the centered max-w-7xl layout
- **Hash routing** (`#/holdings`): adds ~30 lines of router logic, no immediate user value
- **Sub-tabs on Cash & Debts** (option b): more clicks, hides one while viewing the other
- **Single record type per category** (enum): no `all`; would force duplicate categories like "Region (Holdings)" and "Region (Cash)"
- **No applies_to filter, just show all categories in all modals**: keeps v0.4 status quo, but user wants this filter
