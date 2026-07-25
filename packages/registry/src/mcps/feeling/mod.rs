// Onchain Market Sentiment ("feeling") MCP.
//
// Exposes a real-time flow-sentiment read on Uniswap V3 (WETH/USDC 0.05%), derived
// from executed swaps decoded on demand by the substreams-sentiment module.
//
// ── PULL MODE ──────────────────────────────────────────────────────────────────
// Every tool call fetches recent blocks on demand and computes the answer in-process:
//
//   pull.rs     →  resolves head, runs `substreams run` over an ABSOLUTE bounded range,
//                  parses `-o jsonl` output
//   metrics.rs  →  aggregation (the four metrics) + interpretation (labels, divergence,
//                  explanation)
//   server.rs   →  the MCP tool surface
//
// No sink, no `swap` table, no background daemon, and no stale data. This works because
// a BOUNDED range terminates on its own (~3s for 200 blocks). Streaming at chain head
// does not — it is a push stream that never completes — which is why the alternative
// design (sink → Postgres → query) needs a long-running process.
//
// Cost of this choice: ~3s per call instead of milliseconds, and the same blocks are
// re-fetched on every call. Worth it to delete an entire moving part.
//
// Trend needs a *previous* window, so `snapshot()` pulls 2x the requested range in ONE
// call and splits it at the midpoint. Two separate pulls would double the latency and
// let the ranges drift apart as the head advances.
//
// The Substreams module itself is store-free for a related reason: a store would force
// backfill from its initialBlock ("Stores always need to be backfilled from their
// initial block to be usable"), which would make a bounded recent-range pull impossible.
//
// ── The sentiment model, in full ───────────────────────────────────────────────
// A Uniswap V3 `Swap` emits signed int256 amounts where positive means "into the pool".
// Reading only the USDC leg gives an exact label with no heuristic:
//     USDC into pool  → trader paid USDC, received the asset  → BUY
//     USDC out of pool → trader received USDC, paid the asset → SELL
// From that: net flow, imbalance, trend, participation. No smoothing, no fitted
// parameters, no prediction. See metrics.rs.
//
// ── Authority ──────────────────────────────────────────────────────────────────
// This MCP is READ-ONLY by construction. It resolves no vault, holds no key, and builds
// no transaction — the tools cannot move funds because they have no ability to. Any
// bounded-action flow ("propose a trade") belongs behind a separate policy layer plus a
// human approval, calling uniswap_mcp's `swap`. Keeping explanation and execution in
// separate surfaces is what stops a prompt injection in on-chain data from escalating
// into a signature.

pub mod metrics;
pub mod pull;
pub mod server;

pub use metrics::{Sentiment, SentimentSnapshot};
pub use pull::{PullConfig, pull_recent_swaps};
pub use server::FeelingMcpServer;
