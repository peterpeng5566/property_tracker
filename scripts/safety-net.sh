#!/usr/bin/env bash
# safety-net.sh — pre-commit gate for property tracker web companion.
#
# Runs required checks before any commit that touches lib/, portfolio.html,
# docs/workers/, docs/adr/, AGENTS.md, or tests/. See AGENTS.md "Pre-commit
# safety net" for the rule and docs/adr/0010 for the architectural decisions.
#
# Stages (in order):
#   1. ./test.sh                                                              — unit tests for lib/
#   2. node --test tests/worker.contract.test.js                             — conditional (skip if missing)
#   3. wrangler deploy --dry-run --outdir /tmp/property-tracker-worker-build  — Worker bundle sanity
#   4. npx --no-install playwright test                                      — conditional (skip if missing)
#
# Stages 2 and 4 print "skipped" and exit 0 when their target files are absent,
# so this script runs cleanly on a clean tree before tickets 02 and 03 land.
# After all v1.2 tickets land, every stage runs unconditionally.
#
# Exits non-zero on any stage that ran and failed.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$DIR"

echo "═══════════════════════════════════════════════"
echo "  Safety net — Stage 1: unit tests (./test.sh)"
echo "═══════════════════════════════════════════════"
./test.sh

echo ""
echo "═══════════════════════════════════════════════"
echo "  Safety net — Stage 2: worker contract tests"
echo "═══════════════════════════════════════════════"
if [ -f tests/worker.contract.test.js ]; then
  node --test tests/worker.contract.test.js
else
  echo "skipped (no test file: tests/worker.contract.test.js)"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  Safety net — Stage 3: Worker bundle dry-run"
echo "═══════════════════════════════════════════════"
wrangler deploy --dry-run --outdir /tmp/property-tracker-worker-build

echo ""
echo "═══════════════════════════════════════════════"
echo "  Safety net — Stage 4: browser smoke (Playwright)"
echo "═══════════════════════════════════════════════"
if [ -d node_modules/@playwright ] && [ -d tests/browser ]; then
  npx --no-install playwright test
else
  echo "skipped (missing: tests/browser/ or node_modules/@playwright)"
fi

echo ""
echo "✓ Safety net passed."
