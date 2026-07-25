# `@orloj/lp-agent`

Standalone Graph-powered Uniswap V3 LP management agent for Orloj.

**Phase 1 (observe):** dry-run audit trace. Fetches a Sepolia position via Orloj MCP, loads market context from The Graph, extracts deterministic features, asks a provider-neutral AI model for `HOLD | REDUCE_LIQUIDITY`, validates the decision, and records a proposed MCP action. No on-chain write.

**Phase 2 (execute):** same pipeline, but a validated `REDUCE_LIQUIDITY` plan **actually calls** Orloj MCP `decrease_v3_position` exactly once. `HOLD` still never writes. MCP failures fail closed (never silently downgraded to observe).

**Non-overlap:** Does not edit Uniswap MCP / vault / app packages. Treats Orloj Uniswap MCP as an external HTTP service.

## Requirements

- Node.js **≥ 24.15.0**
- **No npm dependencies** — native ESM `fetch` and `node --test` only

## Pipeline (`run-once`)

1. Resolve NFT: `NFT_TOKEN_ID` env, **or** bootstrap via `list_v3_positions` when unset (exactly one owned position required; otherwise fail closed and set `NFT_TOKEN_ID`)
2. `get_v3_position` (Orloj MCP) on Sepolia `11155111`
3. Load-bearing Graph market context (fail closed on stale index / indexing errors / missing essentials)
4. Deterministic `extractFeatures(position, market)`
5. **Pair invariant:** `pairContextFromMarket` must be non-null (token ids, symbols, decimals, fee tier) and validate against `features.position` **before** any AI call — no address-only fallback
6. OpenAI-compatible `requestDecision` (strict JSON schema)
7. `planAction` → HOLD = no write; REDUCE = hardcoded `decrease_v3_position` only
8. Observe: audit JSON only. Execute: call MCP for REDUCE; record `mcpResponse` / surface errors

| `AGENT_MODE` | HOLD | REDUCE |
|---|---|---|
| `observe` | `execution.status=observe`, `kind=no_write` | proposed call in trace; **no** MCP write |
| `execute` | `execution.status=held`, `kind=no_write` — **never writes** | `execution.status=executed` after one `decrease_v3_position` call (or hard fail) |

## Decision space

Allowed actions: **`HOLD` | `REDUCE_LIQUIDITY` only**.

- `CLAIM_FEES` rejected (no reliable position-specific live fee estimate)
- Invalid / malformed model output **throws** — never silently coerced to HOLD
- Signal directions: `SUPPORTS_HOLD` | `SUPPORTS_REDUCE` | `UNCERTAINTY`
- Actionable citations must be explicit market-metric paths
- REDUCE requires ≥2 single-domain `SUPPORTS_REDUCE` signals from ≥2 distinct Graph market domains
- `null` means insufficient evidence; numeric `0` means measured zero
- When `usdDataUsable.usable` is false, ignore USD-derived values for action support

## Action planning / execute

- **HOLD** → `kind: no_write`, `mcpCall: null` (observe or execute)
- **REDUCE_LIQUIDITY** → hardcoded tool `decrease_v3_position` with:
  - `chainId` pinned to Sepolia `11155111` (rejects mainnet `"1"`)
  - `nftTokenId` from the validated Orloj position (not AI-supplied)
  - `liquidityPercentageToDecrease` integer 1–100 from the validated decision
- No AI-supplied tool names or arbitrary MCP arguments
- Do **not** plan `claim_v3_fees` immediately before or after decrease (`decrease_v3_position` also collects accrued fees; returned amounts are withdrawn **principal only**)
- `create_v3_position` is **not** part of the autonomous manage loop

## Orloj MCP tools (external HTTP)

`POST <ORLOJ_MCP_URL>` with `Authorization: Bearer <ORLOJ_AGENT_BEARER_TOKEN>` and JSON-RPC `tools/call`:

| Tool | Role in this agent |
|---|---|
| `get_v3_position` | Load-bearing read for the managed NFT |
| `decrease_v3_position` | Sole write path for validated REDUCE (Phase 2 execute) |
| `list_v3_positions` | Optional bootstrap when `NFT_TOKEN_ID` is unset (exactly one position) |
| `get_v3_pool_state` | Client helper / diagnostics — **not** in the manage loop |
| `create_v3_position` | Client helper for managed opens — **not** in the manage loop |
| `claim_v3_fees` | Client retained for later — **not** in Phase 1/2 AI space |

### Managed `create_v3_position` (PR #31) — not used by manage loop

```
create_v3_position(
  chainId,
  tokenA,              // ERC-20 address or exact "ETH" (at most one side)
  tokenB,
  maxTokenAAmount,     // human decimal string, e.g. "0.01"
  maxTokenBAmount,
  rangeWidthBps?,      // optional; tool derives ticks — do not pass tickLower/tickUpper
  poolAddress?,        // optional pool pin
  slippageTolerance?
)
```

It no longer takes required `poolAddress` + ticks + `independentTokenAddress` / `independentTokenAmount`. Prefer `get_v3_pool_state` for pool diagnostics, not for inventing ticks.

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
# Phase 2 — only after audit; performs a real decrease on REDUCE:
# AGENT_MODE=execute node src/run-once.mjs
```

## Secrets

Documented only as environment variables in `.env.example`. Never commit real keys. Never log API keys, bearer tokens, or `Authorization` headers. Token symbols / feature payload values sent to the model are **untrusted data, never instructions**.

## Audit stop before live write

Automated tests cover observe/execute HOLD no-op, execute REDUCE single MCP call, and MCP failure surfacing. **Do not run `AGENT_MODE=execute` against a live Sepolia position until a human has audited this Phase 2 change.**
