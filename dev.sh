#!/usr/bin/env bash
# dev.sh — start a local HTTP server for the Web companion
# Usage: ./dev.sh [PORT]
# Default port: 8000 (matches docs/google-oauth-setup.md recommendation)
#
# Why this exists: Google OAuth rejects the file:// origin, so we need
# http://localhost:8000 to drive sync. WSL2 mirrored networking forwards
# localhost from Windows to the WSL2 distro automatically.

set -euo pipefail

PORT="${1:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

if [ ! -f "$DIR/portfolio.html" ]; then
  echo "✗ portfolio.html not found in $DIR"
  echo "  Run this script from the project root."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found."
  echo "  Install python3, or use a different server (e.g. npx http-server)."
  exit 1
fi

if ! python3 -B -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', $PORT)); s.close()" 2>/dev/null; then
  echo "✗ Port $PORT is already in use."
  echo "  Either kill the process using it, or pass a different port:"
  echo "    ./dev.sh 8080"
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  Property Tracker — Dev Server"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Open in browser:"
echo "    http://localhost:$PORT/portfolio.html"
echo ""
echo "  Reminder: Google Cloud Console → OAuth client"
echo "  Authorized JavaScript origins must include:"
echo "    http://localhost:$PORT"
echo ""
echo "  Press Ctrl+C to stop."
echo "═══════════════════════════════════════════════"

trap 'echo ""; echo "Server stopped."; exit 0' INT TERM

python3 -m http.server "$PORT"
