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

# Auto-discover all test files. Quoted glob prevents shell expansion issues.
node --test 'tests/*.test.js'

echo ""
echo "✓ All tests passed."
