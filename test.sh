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

if [ ! -f "$DIR/lib/format.js" ]; then
  echo "✗ lib/format.js not found in $DIR"
  exit 1
fi

if [ ! -f "$DIR/tests/format.test.js" ]; then
  echo "✗ tests/format.test.js not found in $DIR"
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  Property Tracker — Automated Tests"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Node: $(node --version)"
echo ""

node --test tests/format.test.js

echo ""
echo "✓ All tests passed."