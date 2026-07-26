# Orloj × The Graph

> *Built at **ETHGlobal Lisbon 2026**.* A Graph-powered LP manager: live Uniswap V3 subgraph data is the only evidence an AI agent is allowed to reason from before it moves real liquidity — and every claim it makes must cite it.

## The pitch

Orloj turns smart contracts into MCP servers that AI agents call as typed tools, and it hand-wrote one special server for Uniswap (see [UNISWAP.md](UNISWAP.md)). That gave agents the *ability* to run V3 liquidity positions. It gave them no basis for **deciding** to.

That basis is The Graph. [packages/lp-agent](packages/lp-agent/) is a specialist agent that manages the Uniswap V3 positions owned by an Orloj agent's wallet on Ethereum Sepolia. On every cycle it discovers the positions, queries the live Uniswap V3 subgraph through the decentralized gateway, turns the response into a deterministic feature set, and asks a model for one of `HOLD` / `REDUCE_LIQUIDITY` / `REBALANCE` — where **every actionable signal must cite an exact non-null feature path derived from Graph data**. Uncited reasoning is rejected, not softened.

**The Graph is load-bearing, not decorative.** There is no RPC fallback, no mocked market data, no static snapshot. If `_meta` is stale, if `hasIndexingErrors` is true, if an expected array is missing, if a scalar is malformed — that evaluation stops and no write happens. Remove The Graph and the agent has nothing to decide with, so it decides nothing.

## What we query

| | |
| --- | --- |
| Gateway | `https://gateway.thegraph.com/api/subgraphs/id` (decentralized network, Bearer auth) |
| Subgraph | `uniswap-v3-sepolia` |
| Subgraph ID | `2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR` |

One fixed query, `PoolMarketContext` ([src/graph-client.mjs](packages/lp-agent/src/graph-client.mjs)), pulls four inputs: current `pool` state, timestamp-bounded `poolHourDatas`, a bounded `swaps` sample, and `_meta` for freshness. Empty `poolHourDatas`/`swaps` arrays with a fresh `_meta` mean *an inactive market* — a measured fact. A missing array means *no evidence* — a failure. Distinguishing those two is the whole point of the response validator.

### Why direct GraphQL and not the Subgraph MCP

Deliberate. This agent manages known pools against a fixed, audited schema, in a path that moves funds. A pinned query gives bounded windows, strict response validation, predictable latency and reproducible evidence. The Subgraph MCP is the better tool for LLM-led subgraph discovery and ad-hoc natural-language querying; letting a model author the queries here would add nondeterminism and another failure mode to a fund-management path without improving a fixed workflow. Substreams stays open as a future adapter behind the same feature contract.

## From subgraph rows to a decision

Deterministic code owns everything except the judgement call:

1. **Cross-validation** — chain ID, NFT, pool address, token pair and fee tier must agree between the Orloj position read and the Graph response, or the evaluation fails closed.
2. **Feature extraction** ([src/features.mjs](packages/lp-agent/src/features.mjs)) — below/in/above-range classification, tick-range width and signed boundary distances, 6h and 24h tick-volatility proxies with minimum sample and span requirements, activity from summed `PoolHourData.txCount` (not sampled swap count), per-token volume windows and trends, fee/TVL, TVL and pool-liquidity trends, plus Graph freshness, indexed block, coverage and missing-input flags. A fail-closed USD gate rejects missing, negative, non-finite or internally inconsistent Sepolia USD figures rather than reasoning over them.
3. **Strict decision** ([src/decision-schema.mjs](packages/lp-agent/src/decision-schema.mjs)) — JSON only; prose, Markdown fences and truncated completions are rejected, and invalid output throws instead of being silently coerced to `HOLD`. `REDUCE_LIQUIDITY` needs at least two supporting signals from two distinct Graph market domains; `REBALANCE` needs two domains including range. Null-or-reason evidence can support uncertainty and nothing else.
4. **Deterministic planning** ([src/action-planner.mjs](packages/lp-agent/src/action-planner.mjs)) — the model never picks tools, addresses, chain IDs, NFT IDs, raw ticks, pools or argument shapes. A decision maps mechanically onto Orloj Uniswap MCP calls, and a `REBALANCE` runs as a guarded state machine (baseline → decrease → optional funding swap → replacement create) with interrupted-write recovery from persisted state.

The output is a per-position audit trace: the Graph metadata, the complete feature object the model saw, the validated decision with its exact citations, the plan, and either the observe-only proposal or the executed calls.

## In the chat

The agent ships as an internal MCP so a user's Orloj chat agent can delegate to it ([PR #32](https://github.com/GianfrancoBazzani/orloj-registry/pull/32)). ZeroClaw stays the conversational supervisor; the LP manager is the specialist it hands one cycle to.

| Tool | Gate | What it does |
| --- | --- | --- |
| `analyze_uniswap_v3_positions` | always | Observe-only: full Graph evidence, decision and plan. Never writes. |
| `manage_uniswap_v3_positions` | `LP_AGENT_CHAT_EXECUTE_ENABLED=true` | One guarded execute cycle. Not advertised when the gate is off. |

Config is server-side and trusted: chain pinned to Sepolia, caller-supplied model/wallet arguments ignored, bearer token resolved to `agent_id` by the route, per-agent state under hashed paths. Chat cannot widen its own authority.

A live observe run on 2026-07-26 found NFT **230399** (USDC/WETH Sepolia, 1% fee, in range at tick ~176955 within 175800–178000), read a **~99.6%** collapse in 6h volume and fees against the prior 6h alongside **+37.7%** pool liquidity growth over 24h, and returned `REDUCE_LIQUIDITY` at 50% with confidence ~0.7 — each signal citing the feature path behind it. No write, because the gate was off.

## On-chain artifacts

No contract of our own. The Graph is consumed as data; positions are touched through Uniswap's own deployments.

| | |
| --- | --- |
| Network | Ethereum Sepolia, chainId **11155111** |
| UniswapV3Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| NonfungiblePositionManager | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| Example managed position | NFT `230399` (USDC/WETH, 1% fee) |

## Files of interest

- [packages/lp-agent/src/graph-client.mjs](packages/lp-agent/src/graph-client.mjs) — the pinned `PoolMarketContext` query and the response validator that fails closed
- [packages/lp-agent/src/features.mjs](packages/lp-agent/src/features.mjs) — subgraph rows → deterministic, citable features
- [packages/lp-agent/src/decision-schema.mjs](packages/lp-agent/src/decision-schema.mjs) — the citation contract the model must satisfy
- [packages/lp-agent/src/action-planner.mjs](packages/lp-agent/src/action-planner.mjs) — decision → exact Uniswap MCP calls
- [packages/lp-agent/src/rebalance.mjs](packages/lp-agent/src/rebalance.mjs) — guarded rebalance state machine and recovery
- [packages/lp-agent/src/mcp-dispatcher.mjs](packages/lp-agent/src/mcp-dispatcher.mjs) — the observe/execute MCP surface exposed to chat
- [packages/app/app/api/lp-agent/mcp/route.ts](packages/app/app/api/lp-agent/mcp/route.ts) — authenticated bridge into the Orloj control plane

## Limitations

- **Sepolia only** — chain ID must be exactly `11155111`; no mainnet funds in this PoC.
- **Manages, does not bootstrap** — the first position is opened by the chat agent or another caller.
- **Run once** — one cycle per invocation; scheduling is external.
- **Subgraph polling, not Substreams** — the deterministic query is the evidence path today.
