#!/usr/bin/env bash
#
# Start the whole local stack: Postgres, the registry, and the frontend.
#
#   ./dev.sh              # start everything
#   ./dev.sh --no-docker  # use an already-running Postgres instead of the container
#
# Idempotent — every step checks before acting, so re-running only starts what is
# actually down. Ctrl-C stops the servers this script started; the Postgres container
# is left running (stop it with `docker compose down`).
#
# What this does NOT do: obtain a Substreams API key for you. That has to be yours.
# Without it everything still runs and only /sentiment degrades.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

USE_DOCKER=1
[ "${1:-}" = "--no-docker" ] && USE_DOCKER=0

LOG_DIR="${TMPDIR:-/tmp}/orloj-dev"
mkdir -p "$LOG_DIR"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Track only the PIDs we spawn, so Ctrl-C never kills a server the user already had.
PIDS=()
cleanup() {
  printf '\n%s==>%s Stopping\n' "$BOLD" "$RESET"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  printf '  %s✓%s servers stopped %s(postgres container left running)%s\n' \
    "$GREEN" "$RESET" "$DIM" "$RESET"
}
trap cleanup INT TERM

# Wait for a port to accept connections. Returns non-zero on timeout so the caller
# can decide whether that is fatal.
wait_for_port() {
  local port=$1 name=$2 tries=${3:-60}
  for _ in $(seq "$tries"); do
    port_busy "$port" && return 0
    sleep 1
  done
  warn "$name did not come up within ${tries}s — see $LOG_DIR"
  return 1
}

# ── 1. Env files ──────────────────────────────────────────────────────────────
step "Environment"

if [ -f packages/registry/.env ]; then
  ok "packages/registry/.env"
elif port_busy 3001; then
  # The registry uses dotenv_override(), so a placeholder .env full of empty values
  # would clobber the working shell exports of an already-running server on its next
  # restart. Never create one behind a live process's back.
  warn "registry already running and has no .env — assuming shell exports, not creating one"
else
  cp packages/registry/.env.example packages/registry/.env
  warn "created packages/registry/.env from the example — fill in your secrets"
fi

if [ ! -f packages/app/.env.local ]; then
  cp packages/app/.env.example packages/app/.env.local
  warn "created packages/app/.env.local from the example — fill in your secrets"
else
  ok "packages/app/.env.local"
fi

# ── 2. Postgres ───────────────────────────────────────────────────────────────
step "Postgres"

if port_busy 5432; then
  ok "already listening on :5432 $DIM(reusing it)$RESET"
elif [ "$USE_DOCKER" = 0 ]; then
  die "--no-docker was passed but nothing is listening on :5432"
elif command -v docker >/dev/null 2>&1; then
  docker compose up -d >/dev/null 2>&1 || die "docker compose up failed — is the daemon running?"
  wait_for_port 5432 "postgres" 45 || die "postgres container never became reachable"
  ok "container started on :5432"
else
  die "docker not found, and nothing is listening on :5432.
      Install Docker, or start your own Postgres and re-run with --no-docker.
      Both services create their own tables, so any empty database works."
fi

# ── 3. Substreams module (optional) ───────────────────────────────────────────
# Only /sentiment depends on this, so a failure here is a warning, never fatal.
step "Substreams module ${DIM}(optional — powers /sentiment)${RESET}"

WASM="packages/substreams-sentiment/target/wasm32-unknown-unknown/release/substreams_sentiment.wasm"

if [ -f "$WASM" ]; then
  ok "built"
  grep -q '^SUBSTREAMS_API_TOKEN=""' packages/registry/.env 2>/dev/null \
    && warn "SUBSTREAMS_API_TOKEN is empty in packages/registry/.env — /sentiment will error"
elif [ -n "${SUBSTREAMS_API_KEY:-}" ]; then
  warn "not built — running setup.sh"
  (cd packages/substreams-sentiment && ./setup.sh) || warn "setup failed; /sentiment will be unavailable"
else
  warn "not built, and SUBSTREAMS_API_KEY is not set — skipping"
  printf '    %sTo enable /sentiment: get a free key at https://thegraph.com/studio, then%s\n' "$DIM" "$RESET"
  printf '    %scd packages/substreams-sentiment && SUBSTREAMS_API_KEY=server_... ./setup.sh%s\n' "$DIM" "$RESET"
fi

# ── 4. Registry ───────────────────────────────────────────────────────────────
step "Registry ${DIM}(:3001)${RESET}"

if port_busy 3001; then
  ok "already running on :3001 $DIM(leaving it alone)$RESET"
else
  command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust: https://rustup.rs"
  printf '  %sbuilding…%s ' "$DIM" "$RESET"
  # Build first so compile errors surface here rather than scrolling past in a log.
  if (cd packages/registry && cargo build --quiet 2>"$LOG_DIR/registry-build.log"); then
    printf '%sdone%s\n' "$GREEN" "$RESET"
  else
    printf '\n'; cat "$LOG_DIR/registry-build.log" >&2
    die "registry failed to build"
  fi
  (cd packages/registry && cargo run --quiet >"$LOG_DIR/registry.log" 2>&1) &
  PIDS+=($!)
  wait_for_port 3001 "registry" 45 && ok "listening on :3001 $DIM($LOG_DIR/registry.log)$RESET"
fi

# ── 5. Frontend ───────────────────────────────────────────────────────────────
step "Frontend ${DIM}(:3000)${RESET}"

if port_busy 3000; then
  ok "already running on :3000 $DIM(leaving it alone)$RESET"
else
  command -v pnpm >/dev/null 2>&1 || die "pnpm not found — https://pnpm.io/installation"
  if [ ! -d node_modules ]; then
    warn "installing dependencies (first run, this takes a minute)"
    pnpm install || die "pnpm install failed"
  fi
  pnpm --filter app dev >"$LOG_DIR/app.log" 2>&1 &
  PIDS+=($!)
  wait_for_port 3000 "frontend" 90 && ok "listening on :3000 $DIM($LOG_DIR/app.log)$RESET"
fi

# ── Ready ─────────────────────────────────────────────────────────────────────
cat <<EOF

${BOLD}Running.${RESET}

  ${BLUE}http://localhost:3000${RESET}            app
  ${BLUE}http://localhost:3000/en/sentiment${RESET}  market sentiment
  ${BLUE}http://localhost:3001/healthz${RESET}       registry health

  ${DIM}logs: $LOG_DIR${RESET}
  ${DIM}Ctrl-C stops the servers this script started.${RESET}

EOF

# Park until Ctrl-C. If nothing was started (everything was already up) there is
# nothing to wait on, so just exit.
[ ${#PIDS[@]} -eq 0 ] && exit 0
wait
