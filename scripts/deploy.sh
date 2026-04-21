#!/usr/bin/env bash
# =============================================================================
# deploy.sh — safe deploy script for pulseup-v4
#
# Usage:
#   ./scripts/deploy.sh              # build + deploy
#   ./scripts/deploy.sh --no-build   # deploy current .next/ without rebuilding
#
# What this script does (and why):
#   1. Optionally runs `npm run build` locally
#   2. Rsyncs .next/standalone/ to VPS — with explicit excludes to avoid wiping:
#        - public/          (not included in standalone output)
#        - node_modules/better-sqlite3/  (macOS binary, must be Linux-built on VPS)
#        - data/            (SQLite DB — never overwrite production data)
#   3. Separately rsyncs .next/static/ and public/ (safe merge, no --delete)
#   4. Does NOT touch .env.local on the VPS
#   5. Reinstalls better-sqlite3 on VPS (Linux build)
#   6. Restarts pm2 process
#   7. Smoke-test: waits for HTTP 200 from https://pulseup.me
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
VPS_HOST="srv1362562.hstgr.cloud"
VPS_USER="root"
VPS_DIR="/var/www/pulseup-v4"
PM2_APP="pulseup-v4"
SMOKE_URL="https://pulseup.me"

SSH="${VPS_USER}@${VPS_HOST}"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}▶ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }
error()   { echo -e "${RED}✗ $*${NC}"; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
BUILD=true
for arg in "$@"; do
  [[ "$arg" == "--no-build" ]] && BUILD=false
done

# ── Step 0: sanity checks ─────────────────────────────────────────────────────
[[ -f "package.json" ]] || error "Run this script from the project root."
[[ -f ".env.local"   ]] || warn ".env.local not found locally — is that expected?"

# ── Step 1: build ─────────────────────────────────────────────────────────────
if $BUILD; then
  info "Building Next.js app..."
  npm run build
else
  warn "Skipping build (--no-build flag)"
  [[ -d ".next/standalone" ]] || error ".next/standalone not found. Run without --no-build first."
fi

# ── Step 2: sync standalone output ───────────────────────────────────────────
info "Syncing .next/standalone/ → VPS (excluding public/, better-sqlite3, data/)..."
rsync -az --delete \
  --exclude 'public/'                        \
  --exclude 'node_modules/better-sqlite3/'   \
  --exclude 'data/'                          \
  .next/standalone/ "${SSH}:${VPS_DIR}/"

# ── Step 3: sync static assets ───────────────────────────────────────────────
info "Syncing .next/static/ → VPS..."
rsync -az .next/static/ "${SSH}:${VPS_DIR}/.next/static/"

info "Syncing public/ → VPS..."
rsync -az public/ "${SSH}:${VPS_DIR}/public/"

# ── Step 4: verify .env.local is present on VPS (never overwrite) ─────────────
info "Checking .env.local on VPS..."
if ssh "${SSH}" "[[ ! -f '${VPS_DIR}/.env.local' ]]"; then
  warn ".env.local NOT found on VPS!"
  warn "You need to upload it manually:"
  warn "  scp .env.local ${SSH}:${VPS_DIR}/.env.local"
  warn "Aborting deploy to avoid a broken app."
  exit 1
fi

# ── Step 5: reinstall better-sqlite3 for Linux ────────────────────────────────
info "Reinstalling better-sqlite3 for Linux on VPS..."
ssh "${SSH}" "cd ${VPS_DIR} && npm install better-sqlite3 --no-save 2>&1 | tail -5"

# ── Step 6: restart pm2 ───────────────────────────────────────────────────────
info "Restarting pm2 process '${PM2_APP}'..."
ssh "${SSH}" "pm2 restart ${PM2_APP} && pm2 save"

# ── Step 7: smoke test ────────────────────────────────────────────────────────
info "Waiting for app to come up..."
sleep 4

MAX_TRIES=10
for i in $(seq 1 $MAX_TRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "${SMOKE_URL}" || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo -e "${GREEN}✓ Smoke test passed (HTTP ${HTTP_CODE}) — ${SMOKE_URL}${NC}"
    break
  fi
  if [[ $i -eq $MAX_TRIES ]]; then
    error "Smoke test failed after ${MAX_TRIES} tries (last status: ${HTTP_CODE})"
  fi
  warn "Try ${i}/${MAX_TRIES}: got HTTP ${HTTP_CODE}, retrying in 3s..."
  sleep 3
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deploy complete → ${SMOKE_URL}${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
