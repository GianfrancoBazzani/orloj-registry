#!/usr/bin/env bash
#
# One-shot setup for the onchain market sentiment MCP.
#
# Idempotent: every step checks before it acts, so re-running is cheap and safe.
# Prints a `.env` line at the end rather than editing your `.env` itself — writing
# a JWT into a file the user did not ask us to touch is not ours to decide.
#
#   ./setup.sh                       # reads SUBSTREAMS_API_KEY from the environment
#   SUBSTREAMS_API_KEY=server_... ./setup.sh
#   ./setup.sh --docker              # build in a container (no local Rust/protoc needed)
#
# Get a free key at https://thegraph.com/studio or https://app.streamingfast.io

set -euo pipefail

cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

WASM="target/wasm32-unknown-unknown/release/substreams_sentiment.wasm"

DOCKER_BUILD=0
[ "${1:-}" = "--docker" ] && DOCKER_BUILD=1

# ── 0. Container build (opt-in) ───────────────────────────────────────────────
# Builds the wasm without Rust, protoc, or the substreams CLI on the host. Useful
# on Linux, where the CLI ships as a tarball rather than a package. Only the BUILD
# is containerized — the registry still invokes `substreams` as a local subprocess,
# so the CLI is needed on the host at run time either way.
if [ "$DOCKER_BUILD" = 1 ]; then
  step "Building in a container"
  command -v docker >/dev/null 2>&1 || die "docker not found"
  docker build -t substreams-sentiment . || die "image build failed"
  docker run --rm -v "$PWD:/out" substreams-sentiment || die "wasm extraction failed"
  [ -f "$WASM" ] || die "container ran but $WASM is missing on the host"
  ok "$WASM ($(du -h "$WASM" | cut -f1))"

  if ! command -v substreams >/dev/null 2>&1; then
    warn "substreams CLI is not on the host — the registry shells out to it at run time"
    printf '    %smacOS: brew install streamingfast/tap/substreams%s\n' "$DIM" "$RESET"
    printf '    %sLinux: https://github.com/streamingfast/substreams/releases%s\n' "$DIM" "$RESET"
  fi
  printf '\n%sModule built.%s Re-run without --docker for the token step.\n' "$BOLD" "$RESET"
  exit 0
fi

# ── 1. Toolchain ──────────────────────────────────────────────────────────────
# Checked before building because cargo's own error for a missing target is much
# harder to act on than a named install command.
step "Checking toolchain"

command -v cargo >/dev/null 2>&1 \
  || die "cargo not found — install Rust: https://rustup.rs"
ok "cargo"

if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  ok "wasm32-unknown-unknown target"
else
  warn "wasm32-unknown-unknown target missing — installing"
  rustup target add wasm32-unknown-unknown
  ok "wasm32-unknown-unknown target installed"
fi

# prost-build shells out to protoc; without it the build fails deep in a build
# script with no mention of protobuf.
if command -v protoc >/dev/null 2>&1; then
  ok "protoc ($(protoc --version))"
else
  die "protoc not found — install it:
      macOS:  brew install protobuf
      Linux:  apt install protobuf-compiler"
fi

# The MCP shells out to this binary at run time — it is a runtime dependency, not
# just a build one.
if command -v substreams >/dev/null 2>&1; then
  ok "substreams CLI ($(substreams --version 2>&1 | head -1))"
else
  die "substreams CLI not found — install it:
      macOS:  brew install streamingfast/tap/substreams
      Linux:  https://github.com/streamingfast/substreams/releases"
fi

# ── 2. Build the module ───────────────────────────────────────────────────────
# target/ is gitignored, so a fresh clone has no .wasm at all.
step "Building the Substreams module"

if [ -f "$WASM" ] && [ -z "${FORCE_BUILD:-}" ]; then
  # Rebuild when any source is newer than the artifact; otherwise a stale wasm
  # would silently serve outdated logic.
  if [ -n "$(find src build.rs Cargo.toml proto abi -newer "$WASM" 2>/dev/null | head -1)" ]; then
    warn "sources changed since last build — rebuilding"
    cargo build --target wasm32-unknown-unknown --release
  else
    ok "already built and up to date $DIM(FORCE_BUILD=1 to rebuild)$RESET"
  fi
else
  cargo build --target wasm32-unknown-unknown --release
fi

[ -f "$WASM" ] || die "build finished but $WASM is missing"
ok "$WASM ($(du -h "$WASM" | cut -f1))"

# Proves the manifest parses and can load the wasm, without needing the network.
if substreams info substreams.yaml >/dev/null 2>&1; then
  ok "manifest validates"
else
  die "substreams.yaml failed to load — run: substreams info substreams.yaml"
fi

# ── 3. Exchange the API key for a JWT ─────────────────────────────────────────
# The raw server_... key is NOT accepted by the endpoint; passing it directly
# fails at stream time with `invalid JWT token`. The JWT lasts ~3650 days.
step "Substreams API token"

if [ -n "${SUBSTREAMS_API_TOKEN:-}" ]; then
  ok "SUBSTREAMS_API_TOKEN already set in this shell"
  printf '\n%sSetup complete.%s\n' "$BOLD" "$RESET"
  exit 0
fi

if [ -z "${SUBSTREAMS_API_KEY:-}" ]; then
  cat <<EOF

  ${YELLOW}!${RESET} SUBSTREAMS_API_KEY is not set, so no token was issued.

    Get a free key at https://thegraph.com/studio or https://app.streamingfast.io,
    then re-run:

      ${BOLD}SUBSTREAMS_API_KEY=server_... ./setup.sh${RESET}

    Everything else is ready — only the token is missing.
EOF
  exit 0
fi

TOKEN=$(curl -sS --fail-with-body -X POST https://auth.streamingfast.io/v1/auth/issue \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$SUBSTREAMS_API_KEY\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])' 2>/dev/null) \
  || die "token exchange failed — check that SUBSTREAMS_API_KEY is valid"

[ -n "$TOKEN" ] || die "token exchange returned an empty token"
ok "JWT issued"

cat <<EOF

${BOLD}Setup complete.${RESET} Add this to ${BOLD}packages/registry/.env${RESET}:

  SUBSTREAMS_API_TOKEN="$TOKEN"

Then start the registry from ${BOLD}packages/registry/${RESET}:

  cargo run

${DIM}The JWT is valid for ~3650 days — this is a one-time step.${RESET}
EOF
