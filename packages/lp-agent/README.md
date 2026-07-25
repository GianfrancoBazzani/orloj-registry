# `@orloj/lp-agent`

Standalone Graph-powered Uniswap V3 LP management agent for Orloj.

**Phase 1 (this package milestone):** single-run observe / dry-run. Fetches a Sepolia position via Orloj MCP, loads market context from The Graph, computes deterministic features, asks an AI model for a multi-factor decision (`HOLD` | `REDUCE_LIQUIDITY`), and emits an auditable proposed MCP action. Real on-chain writes are **not** enabled.

**Phase 2 (after Uniswap PR merge + rebase):** enable `AGENT_MODE=execute` and demonstrate at least one live Sepolia MCP write driven by a Graph-powered decision.

## Requirements

- Node.js **≥ 24.15.0** (matches monorepo `.npmrc` pin)
- **No npm dependencies** — native ESM `fetch` and `node --test` only

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
2. **USD fields are conditionally reliable on Sepolia.** Schema exposes `volumeUSD` / `feesUSD` / `tvlUSD` / `amountUSD`, but values can be absurd or zero while raw token volumes are non-zero. Detect unreliability explicitly; fall back to ticks, raw token volumes, liquidity, and swap activity — never invent USD or use RPC.
3. **`collectedFeesToken0/1` / `collectedFeesUSD` are pool cumulative**, not live position-specific fee accrual. Combined with stale `tokensOwed*`, they do **not** justify Phase 1 `CLAIM_FEES`.
4. **Pool/Token entity IDs are lowercase `Bytes` addresses.** Normalize Orloj’s checksummed `poolAddress` with `toSubgraphPoolId` before `pool(id:)` / `where: { pool: }`.

The Graph is **load-bearing**. There is no RPC or static-data runtime fallback. Fail closed on stale indexing, indexing errors, or missing essential pool data. A fresh `_meta` block with sparse/no recent swaps is valid (inactive market), not a Graph failure.

Orloj supplies the position NFT (pool, ticks, liquidity, ownership). Normalize Orloj’s checksummed `poolAddress` to **lowercase** before using it as a subgraph entity ID.

## Orloj MCP tools (external HTTP)

`POST <ORLOJ_MCP_URL>` with `Authorization: Bearer <ORLOJ_MCP_API_KEY>` and JSON-RPC `tools/call`:

- `get_v3_position` — read position (Phase 1 uses this)
- `decrease_v3_position` — proposed on `REDUCE_LIQUIDITY` (also collects accrued fees; returned amounts are withdrawn principal only)
- `claim_v3_fees` — client support retained for later; **not** in Phase 1 AI decision space (insufficient evidence without a reliable position-specific live fee estimate)
- `create_v3_position` — not used in Phase 1 decisions

Do **not** plan a claim immediately before or after a decrease. API-reported claim amounts are not authoritative realized revenue without receipt-event or balance-delta accounting.

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

Documented only as environment variables in `.env.example`. Never commit real keys. Never log API keys, bearer tokens, wallet secrets, or full `Authorization` headers.
