#!/usr/bin/env bash
# test.sh — run automated tests for the property tracker web companion
# Usage: ./test.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found. Install Node.js 18+ (this project tested on 26.7.0)."
  exit 1
fi

if [ ! -d "$DIR/lib" ]; then
  echo "✗ lib/ directory not found in $DIR"
  echo "  Run this script from the project root."
  exit 1
fi

if [ ! -d "$DIR/tests" ]; then
  echo "✗ tests/ directory not found in $DIR"
  echo "  Run this script from the project root."
  exit 1
fi

if ! ls "$DIR/tests/"*.test.js >/dev/null 2>&1; then
  echo "✗ no *.test.js files found in $DIR/tests/"
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  Property Tracker — Automated Tests"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Node: $(node --version)"
echo ""

# Auto-discover all unit tests. Explicit list (not a glob) so the worker
# contract test (tests/worker.contract.test.js) is excluded — it is run by
# safety-net stage 2 only, per ticket 02. Add new unit tests here when they
# are introduced.
node --test \
  tests/calc.test.js \
tests/group.test.js \
tests/refresh.test.js \
tests/records.test.js \
tests/sync.test.js \
tests/snapshot.test.js \
tests/backup.test.js \
tests/plan.test.js \
tests/order.test.js \
  tests/format.test.js \
  tests/intraday.test.js \
  tests/market-display.test.js \
  tests/serialize.test.js \
  tests/yahoo.test.js \
tests/migration.test.js \
tests/rebalance.test.js \
  tests/dispatch-event-guard.test.js

echo ""
echo "✓ All tests passed."
