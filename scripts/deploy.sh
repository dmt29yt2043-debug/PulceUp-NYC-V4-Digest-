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

# ── Step 1b: pre-deploy QA gate ──────────────────────────────────────────────
# Runs the deterministic QA suite against PRODUCTION before we overwrite it.
# Catches issues that already exist on prod (so we don't deploy on top of a
# broken state and lose the ability to bisect). Also runs the browser-level
# smoke that catches frontend-only regressions (Invalid Date, .map crashes).
# Override with QA_SKIP=1 ./scripts/deploy.sh when prod is intentionally down
# or you're shipping a hotfix that's expected to repair a broken prod.
if [[ "${QA_SKIP:-0}" != "1" ]]; then
  info "Running pre-deploy QA gate (scripts/qa/ci.ts quick)..."
  if ! npx tsx scripts/qa/ci.ts quick; then
    error "QA gate failed. Fix prod first, or set QA_SKIP=1 to override."
  fi
  info "QA gate passed — proceeding to deploy."
else
  warn "QA gate skipped (QA_SKIP=1)"
fi

# ── Step 2: sync standalone output ───────────────────────────────────────────
# IMPORTANT: .next/static/ is NOT in standalone output, so --delete would wipe
# it on the server. Exclude it here; it's synced separately in Step 3.
info "Syncing .next/standalone/ → VPS (excluding public/, better-sqlite3, data/, .next/static/)..."
rsync -az -e "ssh -i ~/.ssh/vps_hostinger" --delete \
  --exclude 'public/'                        \
  --exclude 'node_modules/better-sqlite3/'   \
  --exclude 'data/'                          \
  --exclude '.next/static/'                  \
  --exclude '.env.local'                     \
  --exclude '.env'                           \
  --exclude 'load-env.js'                    \
  .next/standalone/ "${SSH}:${VPS_DIR}/"

# ── Step 3: sync static assets ───────────────────────────────────────────────
info "Syncing .next/static/ → VPS..."
rsync -az -e "ssh -i ~/.ssh/vps_hostinger" --delete .next/static/ "${SSH}:${VPS_DIR}/.next/static/"

info "Syncing public/ → VPS..."
rsync -az -e "ssh -i ~/.ssh/vps_hostinger" public/ "${SSH}:${VPS_DIR}/public/"

# ── Step 4: verify .env.local is present on VPS (never overwrite) ─────────────
info "Checking .env.local on VPS..."
if ssh -i ~/.ssh/vps_hostinger "${SSH}" "[[ ! -f '${VPS_DIR}/.env.local' ]]"; then
  warn ".env.local NOT found on VPS!"
  warn "You need to upload it manually:"
  warn "  scp .env.local ${SSH}:${VPS_DIR}/.env.local"
  warn "Aborting deploy to avoid a broken app."
  exit 1
fi

# ── Step 4b: ensure load-env.js exists + server.js requires it ────────────────
# Next.js standalone server.js does NOT auto-load .env.local at runtime.
# We inject a tiny env-loader so that OPENAI_API_KEY (and friends) are available.
info "Ensuring runtime env-loader is wired into server.js..."
ssh -i ~/.ssh/vps_hostinger "${SSH}" "bash -s" <<'REMOTE_EOF'
set -e
cd "/var/www/pulseup-v4"
# (Re)create the env-loader file — rsync's --exclude keeps it from being wiped,
# but we write it on every deploy so any improvement here lands automatically.
cat > load-env.js <<'LOADER_EOF'
// Loads .env.local into process.env at runtime (Next.js standalone does not).
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
    console.log("[env-loader] .env.local loaded");
  }
} catch (e) { console.error("[env-loader] failed:", e.message); }
LOADER_EOF
# Prepend a require() to server.js if it isn't already there.
grep -q 'require("./load-env.js")' server.js || sed -i '1irequire("./load-env.js");' server.js
REMOTE_EOF

# ── Step 5: reinstall better-sqlite3 for Linux ────────────────────────────────
info "Reinstalling better-sqlite3 for Linux on VPS..."
ssh -i ~/.ssh/vps_hostinger "${SSH}" "cd ${VPS_DIR} && npm install better-sqlite3 --no-save 2>&1 | tail -5"

# ── Step 6: restart pm2 ───────────────────────────────────────────────────────
info "Restarting pm2 process '${PM2_APP}'..."
ssh -i ~/.ssh/vps_hostinger "${SSH}" "pm2 restart ${PM2_APP} && pm2 save"

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

# ── Step 8: post-deploy QA verification ──────────────────────────────────────
# Re-run the full quick suite against the freshly-deployed prod. This is the
# real safety net — if any test fails here, we have a regression we just
# shipped. Exit non-zero so the operator notices (existing PM2 still serves;
# user can investigate before doing anything else).
if [[ "${QA_SKIP:-0}" != "1" ]]; then
  info "Running post-deploy QA verification..."
  if ! npx tsx scripts/qa/ci.ts quick; then
    error "POST-DEPLOY QA FAILED — a regression shipped. Inspect reports/qa/ and roll back if needed."
  fi
  info "Post-deploy QA passed — deploy verified end-to-end."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deploy complete → ${SMOKE_URL}${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
