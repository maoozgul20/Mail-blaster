#!/usr/bin/env bash
# Full-stack browser tests: dashboard + browser extension -> real Worker app -> real PostgreSQL (PGlite) + mock Gmail.
# Never contacts Google and never sends real email. Requires Playwright's Chromium (preinstalled in CI image).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHOTS="${SHOTS:-/tmp/shots}"; mkdir -p "$SHOTS"
cleanup() { pkill -f "tsx test/e2e/server" 2>/dev/null || true; pkill -f "vite preview" 2>/dev/null || true; }
trap cleanup EXIT; cleanup
cd "$ROOT/worker"
PORT=8788 FRONTEND_URL=http://localhost:4173 npx tsx test/e2e/server.ts > "$SHOTS/server.log" 2>&1 &
for i in $(seq 1 60); do curl -sf localhost:8788/__health >/dev/null 2>&1 && break; sleep 1; done
cd "$ROOT/dashboard"
VITE_API_BASE_URL=http://localhost:8788 npx vite build >/dev/null
npx vite preview --port 4173 --strictPort > "$SHOTS/preview.log" 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:4173/login >/dev/null 2>&1 && break; sleep 1; done
SHOTS="$SHOTS" node e2e/dashboard.e2e.cjs
if [ -f "$ROOT/extension/e2e/extension.e2e.cjs" ]; then
  cd "$ROOT/extension" && API_BASE_URL=http://localhost:8788 DASHBOARD_URL=http://localhost:4173 npm run build >/dev/null && SHOTS="$SHOTS" node e2e/extension.e2e.cjs
fi
