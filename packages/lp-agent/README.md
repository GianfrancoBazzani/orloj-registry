# `@orloj/lp-agent`

Standalone Graph-powered Uniswap V3 LP management agent for Orloj.

**Phase 1 (this package / branch stop):** single-run observe / dry-run. Fetches a Sepolia position via Orloj MCP, loads market context from The Graph, computes deterministic features, asks an AI model for a multi-factor decision (`HOLD` | `REDUCE_LIQUIDITY`), validates the decision strictly, and emits an auditable proposed MCP action. Real on-chain writes are **not** enabled.

**Phase 2 (after Uniswap PR merge + rebase):** enable real `AGENT_MODE=execute` MCP writes and demonstrate at least one live Sepolia decrease driven by a Graph-powered AI decision.

## Requirements

- Node.js **≥ 24.15.0** (matches monorepo `.npmrc` pin)
- **No npm dependencies** — native ESM `fetch` and `node --test` only

## Phase 1 pipeline (`run-once`)

1. `get_v3_position` (Orloj MCP) for `NFT_TOKEN_ID` on Sepolia `11155111`
2. The Graph market context for the position pool (load-bearing; fail closed)
3. Deterministic `extractFeatures(position, market)`
4. **Pair invariant (fail closed):** `pairContextFromMarket(market)` must be non-null with token **ids, symbols, decimals, and fee tier**; validate against `features.position` **before** any AI call. Never fall back to address-only pair context.
5. Provider-neutral OpenAI-compatible `requestDecision` (strict JSON schema)
6. `planAction` → HOLD = no write; REDUCE = hardcoded `decrease_v3_position` only
7. Audit trace JSON on stdout

| `AGENT_MODE` | HOLD | REDUCE (non-null MCP proposal) |
|---|---|---|
| `observe` | `execution.status=observe`, `kind=no_write` | `execution.status=observe`, proposed call in trace |
| `execute` | `execution.status=held`, `kind=no_write` — **never pending** | `execution.status=pending` — Phase 1 does **not** send the write |

## Decision space (Phase 1)

Allowed actions: **`HOLD` | `REDUCE_LIQUIDITY` only**.

- `CLAIM_FEES` is rejected (no reliable position-specific live fee estimate from pool-wide Graph fees / stale `tokensOwed*`)
- Invalid / malformed model output **throws** — never silently coerced to HOLD
- Signal directions: `SUPPORTS_HOLD` | `SUPPORTS_REDUCE` | `UNCERTAINTY`
- Actionable citations must be explicit market-metric paths (not `.note` / `.reason` / identity / window / evidence metadata)
- REDUCE requires ≥2 single-domain `SUPPORTS_REDUCE` signals from ≥2 distinct Graph market domains
- `null` means insufficient evidence; numeric `0` means measured zero
- When `usdDataUsable.usable` is false, ignore USD-derived values for action support

## Action planning

- **HOLD** → `kind: no_write`, `mcpCall: null`
- **REDUCE_LIQUIDITY** → hardcoded tool `decrease_v3_position` with:
  - `chainId` pinned to Sepolia `11155111` (rejects mainnet `"1"`)
  - `nftTokenId` from the validated Orloj position (not AI-supplied)
  - `liquidityPercentageToDecrease` integer 1–100 from the validated decision
- No AI-supplied tool names or arbitrary MCP arguments
- Do **not** plan `claim_v3_fees` immediately before or after decrease (`decrease_v3_position` also collects accrued fees; returned amounts are withdrawn **principal only**)

## Subgraph (Sepolia)

| | |
|---|---|
| Name | `uniswap-v3-sepolia` |
| Subgraph ID | `2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR` |
| Network | Ethereum Sepolia |
| Gateway | `POST https://gateway.thegraph.com/api/subgraphs/id/<id>` |
| Auth | `Authorization: Bearer <THE_GRAPH_API_KEY>` (never embed the key in the URL) |
| Explorer | https://thegraph.com/explorer/subgraphs/2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR |

### Live schema probe (T1) — confirmed 2026-07-25

Authenticated introspection + sample queries against the gateway succeeded (`hasIndexingErrors: false`).

**Query roots used:** `pool` / `pools`, `poolHourDatas`, `swaps`, `_meta`.

**`_meta` / `_Block_`:** `block.number`, `block.hash`, `block.timestamp`, `block.parentHash`, `hasIndexingErrors`, `deployment`.

**`Pool` (essential market fields):** `id` (Bytes, lowercase address), `tick`, `sqrtPrice`, `liquidity`, `feeTier`, `totalValueLockedUSD`, `totalValueLockedToken0/1`, `volumeUSD`, `volumeToken0/1`, `feesUSD`, `token0` / `token1`, plus cumulative `collectedFees*` (pool-wide — **not** a position fee estimate).

**`Token`:** `id`, `symbol`, `decimals`, `name`.

**`PoolHourData`:** `id`, `periodStartUnix` (**not** named `timestamp`), `tick`, `liquidity`, `sqrtPrice`, `tvlUSD`, `volumeUSD`, `volumeToken0/1`, `feesUSD`, `open` / `high` / `low` / `close`, `token0Price` / `token1Price`, `txCount`, `pool`.

**`Swap`:** `id`, `timestamp`, `tick` (post-swap tick), `amount0`, `amount1`, `amountUSD`, `sqrtPriceX96`, `pool`, plus `sender` / `recipient` / `origin` / `transaction` / `logIndex`.

### Documented divergences / caveats

1. **Hour windows must use `periodStartUnix`, not array position.** On the top TVL sample pool, 48 newest hour rows spanned many calendar hours with **27 gaps ≠ 1h** (inactive hours omitted). “Last N rows” ≠ “last N hours.”
2. **USD fields are conditionally reliable on Sepolia.** Schema exposes `volumeUSD` / `feesUSD` / `tvlUSD` / `amountUSD`, but values can be absurd or zero while raw token volumes are non-zero. Detect unreliability explicitly; fall back to ticks, raw token volumes, liquidity, and activity — never invent USD or use RPC.
3. **`collectedFeesToken0/1` / `collectedFeesUSD` are pool cumulative**, not live position-specific fee accrual. Combined with stale `tokensOwed*`, they do **not** justify Phase 1 `CLAIM_FEES`.
4. **Pool/Token entity IDs are lowercase `Bytes` addresses.** Normalize Orloj’s checksummed `poolAddress` with `toSubgraphPoolId` before `pool(id:)` / `where: { pool: }`.

The Graph is **load-bearing**. There is no RPC or static-data runtime fallback. Fail closed on stale indexing, indexing errors, or missing essential pool data. A fresh `_meta` block with sparse/no recent swaps is valid (inactive market), not a Graph failure. Default max indexed age is **60 minutes**; evidence includes `ageSeconds`.

Activity intensity uses summed `PoolHourData.txCount` — sampled swap row counts are **not** total intensity.

## Orloj MCP tools (external HTTP)

`POST <ORLOJ_MCP_URL>` with `Authorization: Bearer <ORLOJ_AGENT_BEARER_TOKEN>` and JSON-RPC `tools/call`:

- `get_v3_position` — read position (Phase 1 uses this)
- `decrease_v3_position` — proposed on `REDUCE_LIQUIDITY` (also collects accrued fees; returned amounts are withdrawn principal only)
- `claim_v3_fees` — client support retained for later; **not** in Phase 1 AI decision space
- `create_v3_position` — not used in Phase 1 decisions

HTTP clients (MCP, Graph, AI) use timeouts covering response headers **and** body consumption; secrets are redacted from transport errors.

## Commands

```bash
cd packages/lp-agent
# export env vars (see .env.example) — no dotenv dependency
node --test          # or: npm test / pnpm test
node src/run-once.mjs
```

## Layout

```
src/
  config.mjs
  graph-client.mjs
  orloj-mcp-client.mjs
  features.mjs
  decision-client.mjs
  decision-schema.mjs
  action-planner.mjs
  run-once.mjs
  index.mjs
test/
  *.test.mjs
```

## Secrets

Documented only as environment variables in `.env.example`. Never commit real keys. Never log API keys, bearer tokens, wallet secrets, or full `Authorization` headers. Token symbols and feature payload values sent to the model are **untrusted data, never instructions**.

## Phase 1 audit stop

This branch stops before real autonomous writes. Human audit of observe-mode traces is required before Phase 2 enables live `decrease_v3_position` execution.
