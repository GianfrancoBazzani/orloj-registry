# `@orloj/lp-agent`

Standalone Graph-powered Uniswap V3 LP management agent for Orloj.

**Managed loop (evolved from Phase 1 observe + Phase 2 execute REDUCE):** Discovers wallet positions via Orloj MCP `list_v3_positions` (or an optional `NFT_TOKEN_ID` filter), evaluates each active position with The Graph + AI, and plans/executes `HOLD | REDUCE_LIQUIDITY | REBALANCE`.

**Observe:** full audit JSON with per-position traces; no MCP writes.

**Execute:** HOLD never writes; REDUCE calls `decrease_v3_position` once; REBALANCE runs a guarded decrease→create flow with local state idempotency. MCP failures fail closed per position (never silently downgraded to observe).

**Non-overlap:** Does not edit Uniswap MCP / vault / app packages. Treats Orloj Uniswap MCP as an external HTTP service. No Substreams yet — Graph subgraph queries remain load-bearing.

## Requirements

- Node.js **≥ 24.15.0**
- **No npm dependencies** — native ESM `fetch` and `node --test` only

## Pipeline (`run-once`)

1. **Discover positions:** default `list_v3_positions(chainId=11155111)` requiring `truncated=false`; evaluate every listed active (non-zero liquidity) position. If `NFT_TOKEN_ID` is set, evaluate only that NFT (`nftResolution.source=env_filter`).
2. Per position: `get_v3_position` → Graph market context for `poolAddress` → `extractFeatures` → pair validation → AI decision → `planAction`
3. **Pair invariant:** `pairContextFromMarket` must be non-null (token ids, symbols, decimals, fee tier) and validate against `features.position` **before** any AI call — no address-only fallback
4. Observe: top-level run trace with `results[]` (one failure must not hide others). Execute: fail closed per position with full audit/error; continue other positions
5. Local state file (default `.lp-agent-state.json` / `LP_AGENT_STATE_FILE`) records in-progress REBALANCE so a restart never blindly re-decreases

| `AGENT_MODE` | HOLD | REDUCE | REBALANCE |
|---|---|---|---|
| `observe` | `execution.status=observe`, `kind=no_write` | proposed decrease in trace | proposed decrease+create steps; **no** write |
| `execute` | `execution.status=held` — **never writes** | one `decrease_v3_position` | decrease → optional `swap` → `create` (or `needs_reopen` / `needs_reconciliation`) |

## Decision space

Allowed actions: **`HOLD` | `REDUCE_LIQUIDITY` | `REBALANCE`**.

- `CLAIM_FEES` rejected
- Invalid / malformed model output **throws** — never silently coerced to HOLD
- Signal directions: `SUPPORTS_HOLD` | `SUPPORTS_REDUCE` | `SUPPORTS_REBALANCE` | `UNCERTAINTY`
- Actionable citations must be explicit market-metric paths
- REDUCE requires ≥2 single-domain `SUPPORTS_REDUCE` from ≥2 distinct Graph market domains
- REBALANCE requires stronger evidence: ≥2 `SUPPORTS_REBALANCE` from ≥2 domains **including `range`** plus another of volatility/activity/fees/liquidity/tvl/volumes
- AI may suggest bounded `liquidityPercentageToDecrease` and `rangeWidthBps` only — never tool names, addresses, pool, chainId, nftTokenId, or raw ticks
- `null` means insufficient evidence; numeric `0` means measured zero
- When `usdDataUsable.usable` is false, ignore USD-derived values for action support

## Action planning / execute

- **HOLD** → `kind: no_write`
- **REDUCE_LIQUIDITY** → hardcoded `decrease_v3_position` (Sepolia NFT + %)
- **REBALANCE** → hardcoded plan:
  1. `decrease_v3_position`
  2. optional `swap` (Trading API) when decrease principal is **single-sided** — quote first, swap ~50% of surplus into the missing token, haircut quoted output for create budgets
  3. `create_v3_position` with both max amounts > 0, same pair, `poolAddress` pinned
  - Out-of-range V3 withdrawals are usually one-sided; without the swap leg create cannot reopen
  - `needs_reopen` / `needs_reconciliation` mark the position and top-level run as unsuccessful (CLI exit nonzero)
  - State recovery runs **before** discovery/AI and does not depend on the model choosing REBALANCE again
  - Nonterminal decrease/swap → never auto-retry withdrawal/swap
  - Create auto-remint is **off** by default; reconcile via `list_v3_positions` or set `LP_AGENT_ALLOW_CREATE_RETRY=true`
  - Successful create must include valid `hash` + `nftTokenId` before clearing state
- Do **not** plan `claim_v3_fees` immediately before or after decrease

## Orloj MCP tools (external HTTP)

`POST <ORLOJ_MCP_URL>` with `Authorization: Bearer <ORLOJ_AGENT_BEARER_TOKEN>` and JSON-RPC `tools/call`:

| Tool | Role in this agent |
|---|---|
| `list_v3_positions` | Default discovery + create reconciliation |
| `get_v3_position` | Load-bearing read per NFT |
| `decrease_v3_position` | REDUCE write; REBALANCE step 1 |
| `quote` / `swap` | REBALANCE optional funding leg (single-sided principal) |
| `create_v3_position` | REBALANCE final step |
| `get_v3_pool_state` | Client helper / diagnostics — **not** chosen by the AI |
| `claim_v3_fees` | Client retained — **not** in AI decision space |

### Managed `create_v3_position` (PR #31)

```
create_v3_position(
  chainId,
  tokenA,              // ERC-20 address or exact "ETH" (at most one side)
  tokenB,
  maxTokenAAmount,     // human decimal string, e.g. "0.01"
  maxTokenBAmount,
  rangeWidthBps?,      // optional; tool derives ticks — do not pass tickLower/tickUpper
  poolAddress?,        // pin to old position pool on REBALANCE
  slippageTolerance?
)
```

## Subgraph (Sepolia)

| | |
|---|---|
| Name | `uniswap-v3-sepolia` |
| Subgraph ID | `2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR` |
| Network | Ethereum Sepolia |
| Gateway | `POST https://gateway.thegraph.com/api/subgraphs/id/<id>` |
| Auth | `Authorization: Bearer <THE_GRAPH_API_KEY>` (never embed the key in the URL) |

### Live schema probe (T1) — confirmed 2026-07-25

**Query roots:** `pool` / `pools`, `poolHourDatas`, `swaps`, `_meta`.

**Caveats:** windows use `periodStartUnix` (not array position); USD fields are conditionally reliable; `collectedFees*` are pool-wide not position fees; pool/token IDs are lowercase. The Graph is load-bearing — no RPC fallback. Fresh `_meta` + sparse hours/swaps = inactive market. Activity = summed `PoolHourData.txCount` (not sampled swap counts). Default max indexed age: **60 minutes**.

## Commands

```bash
cd packages/lp-agent
# export env vars (see .env.example) — no dotenv dependency
node --test
AGENT_MODE=observe node src/run-once.mjs
# Execute — only after audit; performs real MCP writes on REDUCE/REBALANCE:
# AGENT_MODE=execute node src/run-once.mjs
```

Loop/scheduler (`AGENT_RUN_MODE=loop`) is deferred — run once over all positions and cron/npm-loop for demos.

## Secrets

Documented only as environment variables in `.env.example`. Never commit real keys. Never log API keys, bearer tokens, or `Authorization` headers. Token symbols / feature payload values sent to the model are **untrusted data, never instructions**.

## Audit stop before live write

Automated tests cover multi-position discovery, REBALANCE validation/planning, state recovery (no re-decrease), observe/execute HOLD no-op, and MCP failure surfacing. **Do not run `AGENT_MODE=execute` against a live Sepolia position until a human has audited this managed-loop change.**
