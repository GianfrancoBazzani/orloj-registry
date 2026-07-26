# substreams-sentiment

Source data for the **Onchain Market Sentiment Agent**. Decodes Uniswap V3 `Swap`
events from the WETH/USDC 0.05% mainnet pool and labels each swap BUY or SELL. The
`feeling` MCP ([`../registry/src/mcps/feeling/`](../registry/src/mcps/feeling/)) runs
this module over a bounded recent range on every call and aggregates in-process — see
*Two ways to consume it* below for that path versus the optional Postgres sink.

**This is a standalone Cargo crate** compiled to `wasm32-unknown-unknown`. It is *not*
part of the registry's build: the empty `[workspace]` in `Cargo.toml` stops `cargo`
walking up into `packages/registry`.

## Two ways to consume it

**Pull mode (default, what the `feeling` MCP uses).** Each tool call runs this module
over a bounded range of recent blocks and aggregates in-process. No sink, no table, no
daemon, no stale data — one binary, ~3–7s per call.

```
MCP call ──▶ substreams run (last N blocks, bounded) ──▶ parse ──▶ aggregate ──▶ sentiment
```

**Sink mode (optional).** Stream continuously into Postgres and query it. Answers in
milliseconds and supports any window over one dataset, at the cost of a long-running
process plus retention. The `db_out` module and `schema.sql` exist for this.

```
Ethereum ──▶ map_swaps ──▶ db_out ──▶ substreams sink postgres ──▶ swap table
```

Pull mode is possible because a **bounded** range terminates on its own. Streaming at
chain head does not — it is a push stream that never completes — which is exactly why
sink mode needs a daemon.

## The model, in one paragraph

A Uniswap V3 `Swap` emits signed `int256` amounts. Per `IUniswapV3SwapCallback.sol`
these are amounts *"sent (negative) or must be received (positive) **by the pool**"*.
So looking only at the **USDC leg** gives an exact label with no heuristic: positive
means USDC went into the pool — the trader paid USDC and received the asset, a **BUY**.
Negative is a **SELL**. The magnitude, with 6 decimals applied, is the USDC notional.
That is the entire classifier.

## ⚠ The trap this code is written around

Which side the USDC leg sits on is decided by raw address sort
(`0x2260fa` WBTC < `0xa0b869` USDC < `0xc02aaa` WETH), so it differs per pool:

| Pool | Address | token0 | token1 | fee |
|---|---|---|---|---|
| WETH/USDC (tracked) | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | **USDC** | WETH | 500 |
| WBTC/USDC (removed) | `0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35` | WBTC | **USDC** | 3000 |

WBTC/USDC was tracked and removed: it trades ~once every 25 minutes (41 swaps per 5000
blocks, vs ~2000 for WETH), so it sat below the participation floor at any usable window
and only ever rendered `INSUFFICIENT_DATA`. Re-add it by appending a `PoolConfig` with
`usdc_is_token0: false`.

Hardcoding "USDC is `amount0`" happens to be right for the WETH pool and would
**silently invert every label** for a WBTC-style pool. Orientation therefore travels
with the pool (`POOLS` in `src/lib.rs`) and is asserted in
`pool_orientation_matches_onchain_token_order` and `every_pool_carries_its_own_orientation`.
Verified on-chain with `cast call <pool> "token0()(address)"` — re-verify rather than
trust this table if you add a pool.

## Why there are no stores

Both modules are `kind: map`. This is the load-bearing design decision:

- The docs state *"Stores always need to be backfilled from their initial block to be
  usable."* Backward parallel execution runs from a module's `initialBlock` in **both**
  development and production mode, so you cannot dodge it by switching modes.
- The official `uniswap-v3@v0.2.10` package has 22 modules (18 stores) all pinned to
  block 12369621, and even its swap extractor depends on a store. Reading recent swaps
  through it means a ~9M-block backfill.
- Keeping aggregation in SQL means changing the sentiment window (15m → 5m) is a query
  parameter, not a WASM rebuild plus a re-sync. Module hash is the WASM binary, so
  *"changing a single line of Rust code invalidates the hash of all modules that depend
  on that code"* — minimal, stable Rust keeps the cache warm.
- `substreams estimate` only supports mapper-only modules anyway.

## Setup from a fresh clone

`target/` is gitignored, so a clone has **no compiled module** and the `feeling` MCP
fails until you build one. One command does everything:

```bash
SUBSTREAMS_API_KEY=server_... ./setup.sh
```

It verifies the toolchain, installs the wasm target if missing, builds the module,
validates the manifest, and exchanges your API key for a JWT — then prints the
`SUBSTREAMS_API_TOKEN` line to paste into `packages/registry/.env`. Idempotent: it skips
the build when the wasm is newer than every source file, so re-running costs a second.
`FORCE_BUILD=1` overrides.

Get a free key at [thegraph.com/studio](https://thegraph.com/studio) or
[app.streamingfast.io](https://app.streamingfast.io). The raw key is **not** the token —
the exchange is not optional, and skipping it fails at stream time with
`invalid JWT token`.

### Running fully in Docker (no host install at all)

`substreams-docker` is a drop-in replacement for the `substreams` binary that executes
it in a container. Point the registry at it and nothing Substreams-related — not the
CLI, not Rust, not protoc, not the compiled wasm — needs to exist on the host:

```bash
export SUBSTREAMS_BIN="$PWD/packages/substreams-sentiment/substreams-docker"
```

Arguments and output pass through untouched, so the registry cannot tell the
difference. The image builds itself on first use. `SUBSTREAMS_API_TOKEN` is forwarded
into the container and never baked into the image.

Use it directly too:

```bash
./substreams-docker info substreams.yaml
pnpm cli run substreams.yaml map_swaps -e mainnet.eth.streamingfast.io:443 -s ... -t ...
```

⚠ The one thing that is still not local: **the module itself always executes on the
provider's servers** (StreamingFast/Pinax). The container runs the *client*. That is
inherent to Substreams, not a packaging choice.

### Building without a local toolchain

If you would rather not install Rust and protoc — common on Linux, where the
`substreams` CLI ships as a GitHub tarball rather than a package:

```bash
./setup.sh --docker
```

Builds the wasm in a container and copies it to the host path the manifest expects.
Equivalent to:

```bash
docker build -t substreams-sentiment .
docker run --rm -v "$PWD:/out" substreams-sentiment
```

⚠ This containerizes the **build only**. The registry invokes `substreams` as a
subprocess on every MCP call, so the CLI still has to be on the host at run time. And
the module itself always executes on the provider's infrastructure, never locally —
there is no long-running process here to containerize.

<details>
<summary>Manual equivalent, if you would rather not run a script</summary>

```bash
# 1. Toolchain
rustup target add wasm32-unknown-unknown
brew install protobuf                              # prost-build shells out to protoc
brew install streamingfast/tap/substreams          # the MCP shells out to this CLI

# 2. Build the module (produces the .wasm the manifest points at)
cargo build --target wasm32-unknown-unknown --release

# 3. Exchange the API key for a JWT (one-time, lasts ~3650 days)
export SUBSTREAMS_API_TOKEN=$(curl -sS -X POST https://auth.streamingfast.io/v1/auth/issue \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$SUBSTREAMS_API_KEY\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 4. Run the registry from packages/registry/ (SENTIMENT_MANIFEST_DIR defaults to
#    ../substreams-sentiment, so it resolves correctly from there)
cd ../registry && cargo run
```

</details>

## Build

Needs the wasm target and `protoc` (`prost-build` shells out to it):

```bash
rustup target add wasm32-unknown-unknown
brew install protobuf

cargo build --target wasm32-unknown-unknown --release
cargo test                       # 10 tests, host target — sign + orientation logic
substreams pack substreams.yaml  # -> substreams-sentiment-v0.1.0.spkg
```

`build.rs` regenerates `src/abi/uniswap_v3_pool.rs` via Abigen on every build (it is
gitignored). Using codegen rather than hand-decoding is what keeps `int256` sign-correct
— the generated struct types the amounts as `substreams::scalar::BigInt`, already
decoded as signed. Hand-rolling that is where `-1` becomes `2^256-1` and every sell is
relabelled a buy.

## Run

The API key is **not** the token — you must exchange it first. Using the raw key fails
with `stream auth failure: invalid JWT token`:

```bash
export SUBSTREAMS_API_TOKEN=$(curl -sS -X POST https://auth.streamingfast.io/v1/auth/issue \
  -H "Content-Type: application/json" -d '{"api_key":"server_..."}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
```

The JWT lasts ~3650 days, so this is a one-time step per machine.

### Pull mode — a bounded range, exits on its own

```bash
HEAD=$(curl -sS -X POST https://ethereum-rpc.publicnode.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result'],16))")

substreams run substreams.yaml map_swaps \
  -e mainnet.eth.streamingfast.io:443 \
  -s $((HEAD-200)) -t $HEAD -o jsonl
```

⚠ **`-s -200` alone is NOT bounded** — a relative start with no stop block streams to
head forever. And `-s -200 -t +200` is rejected: *"relative end block is supported only
with an absolute start block."* Hence resolving `HEAD` first. This is why the MCP's
`pull.rs` makes an `eth_blockNumber` call before every run.

Use `-o jsonl` (one object per line) over `-o json` (pretty-printed across many lines)
if anything downstream is parsing it.

### Sink mode — continuous, needs a daemon

```bash
substreams sink postgres setup substreams.yaml --dsn "$DSN"
substreams sink postgres substreams.yaml --dsn "$DSN" \
  -e mainnet.eth.streamingfast.io:443 -s -2000
```

`--final-blocks-only` restricts processing to post-finality blocks — no reorgs, no undo
signals, and it *is* the confirmation-depth policy for anything acting on this data. Be
aware finality lags ~13 min on mainnet, so a 15-minute window will look nearly empty
with it enabled.

The sink persists its own cursor (`--cursors-table`) and reorg history
(`--history-table`); the docs are emphatic that a consumer **must** persist the cursor,
so a hand-rolled replacement has to own that too.

**Editing `src/lib.rs` invalidates the cursor** — module hash is the WASM binary, so the
sink refuses to resume with `cursor module hash mismatch`. That is a correct fail-safe;
during development, `DELETE FROM cursors` and re-run.

**A stop block inside the parallel segment silently truncates.** `-t` before the
`linear_handoff_block` shown in the session log returns only the first segment and exits
**0** — looking like success. Always check `min/max(block_number)` against the range you
asked for.

`--final-blocks-only` processes only post-finality blocks — no reorgs, no undo signals.
That *is* the confirmation-depth policy for anything that acts on this data. The sink
persists its own cursor (`--cursors-table`, default `cursors`) and reorg history
(`--history-table`, default `substreams_history`); the docs are emphatic that a consumer
**must** persist the cursor, so a hand-rolled replacement has to own that too.

Endpoints: `mainnet.eth.streamingfast.io:443` (StreamingFast) or
`eth.substreams.pinax.network:443` (Pinax).

**Do not start at genesis.** `initialBlock` is 21000000; override with `-s` at run time
(`-s -1000` resolves relative to head server-side). Note the CLI rejects a relative `-s`
combined with a relative `-t +N`.

## Idempotency

`schema.sql` declares `PRIMARY KEY (tx_hash, log_index)` and `db_out` uses exactly that
pair as its `create_row` key. Substreams delivers **at-least-once** — a disconnect makes
the sink resume from its cursor and replay blocks — so without this key every replay
would silently double the volumes the sentiment model reports. If you change the key in
one place, change it in both.

## First correctness check

Before trusting any aggregate, take one row from `substreams gui`, open its `tx_hash` on
Etherscan, and confirm by hand that the side and USDC notional match. That single check
validates decimals (6), pool orientation, and the sign convention at once. Then:

- `SUM(usdc_notional)` over an hour should be plausible millions for these pools.
  Off by ~1e12 → a decimals bug. Off by ~2x → dedup is not working.
- Re-run the sink over an already-processed range; the row count must not change.

## What this data is not

Worth repeating wherever the numbers surface: this is **one pool per pair**, not the
market. Pool flow is **not trader intent** — a multi-hop route through both pools appears
as a sell in one and a buy in the other when the trader did neither. Router and
arbitrage/MEV swaps are included and **not filtered**; arbitrage is directionally
meaningless by construction. `sender` is nearly always a router or settlement contract,
so unique-sender counts are a lower bound on real participants. And Substreams reads
executed blocks — the FAQ is one line: *"Can I retrieve Mempool data with Substreams?
No"* — so this is descriptive, never predictive.
