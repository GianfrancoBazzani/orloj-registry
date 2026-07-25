// FeelingMcpServer — the sentiment MCP surface.
//
// PULL MODE: every tool call runs the Substreams module over a bounded range of recent
// blocks and computes the answer in-process. No sink, no `swap` table, no background
// daemon, no stale data. A bounded range terminates on its own (~3s for 200 blocks),
// which is what makes an on-demand read possible; streaming at chain head does not, and
// is why the alternative design needs a long-running process.
//
// Mirrors the dispatch shape of uniswap_mcp/native_mcp: a JSON-RPC `dispatch()` for the
// HTTP transport plus a `ServerHandler` impl for stdio. Unlike those, this server is
// READ-ONLY: it holds no vault, resolves no signing key, and constructs no transaction.
//
// That is a deliberate authority boundary. Event payloads are attacker-controlled —
// anyone can deploy a token whose metadata is a prompt injection and get it in front of
// a model for the price of gas. A tool surface that *cannot* sign is one that cannot be
// talked into signing. Any bounded-action flow belongs behind a separate policy layer
// and a human approval, calling uniswap_mcp's `swap`.

use std::sync::Arc;

use anyhow::{Context, Result};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    model::*,
    service::{RequestContext, RoleServer},
};
use serde_json::{Map, Value, json};

use crate::{
    db::DbPool,
    mcps::feeling::{
        metrics::{CAVEAT, PARTICIPATION_FLOOR, SentimentSnapshot},
        pull::{DEFAULT_BLOCKS, MAX_BLOCKS, MIN_BLOCKS, PullConfig, pull_recent_swaps},
    },
};

/// Mainnet blocks are ~12s, so this converts a block count into an approximate window
/// for display. Approximate on purpose — block times vary.
const SECONDS_PER_BLOCK: u64 = 12;

fn blocks_to_minutes(blocks: u64) -> i64 {
    ((blocks * SECONDS_PER_BLOCK) / 60) as i64
}

#[derive(Clone)]
pub struct FeelingMcpServer {
    agent_id: Option<String>,
    /// Used only for tool-call logging — never for reading swap data in pull mode.
    db: Option<Arc<DbPool>>,
}

impl FeelingMcpServer {
    pub fn new(agent_id: Option<String>, db: Option<Arc<DbPool>>) -> Self {
        Self { agent_id, db }
    }

    fn instructions() -> &'static str {
        "Real-time onchain flow sentiment for Uniswap V3 pairs. Each call fetches the \
         most recent blocks from Ethereum on demand and computes the answer fresh — \
         there is no cache and no stored history, so a call takes a few seconds. \
         READ-ONLY: these tools move no funds, sign nothing, and hold no keys. \
         \
         get_sentiment(pair, blocks?) returns net flow (USDC), volume-weighted imbalance \
         in [-1,+1], count-weighted imbalance, participation (swap count + unique \
         senders), and a label. explain_sentiment(pair, blocks?) returns the same reading \
         as plain language with its caveats. get_recent_swaps(pair, blocks?, limit?) \
         returns the individual swaps behind the aggregate so any figure can be checked \
         against a block explorer. list_pairs() shows what is indexed. \
         \
         Read the numbers honestly: this is ONE pool per pair, not the market. Pool flow \
         is not trader intent (a multi-hop route appears as a sell in one pool and a buy \
         in another). Router and arbitrage/MEV swaps are included and NOT filtered. \
         Substreams reads executed blocks and cannot see the mempool, so this is \
         descriptive, never predictive — do not present it as a forecast or a trade \
         signal, and do not infer a price target from it. When the label is \
         INSUFFICIENT_DATA, say so plainly rather than reaching for the raw imbalance."
    }

    // ── tool list ───────────────────────────────────────────────────────────────

    fn tools() -> Vec<Tool> {
        let pair_prop = json!({
            "type": "string",
            "description": "Trading pair. Currently only \"WETH/USDC\" is tracked — call list_pairs to confirm."
        });
        let blocks_prop = json!({
            "type": "integer",
            "description": format!(
                "How many recent blocks to analyse ({MIN_BLOCKS}-{MAX_BLOCKS}, default \
                 {DEFAULT_BLOCKS}). Mainnet blocks are ~12s, so {DEFAULT_BLOCKS} blocks \
                 is roughly {} minutes. Larger ranges are more stable but slower to \
                 fetch and cover a longer, less current period.",
                blocks_to_minutes(DEFAULT_BLOCKS)
            ),
        });

        let mut sentiment_props = Map::new();
        sentiment_props.insert("pair".into(), pair_prop.clone());
        sentiment_props.insert("blocks".into(), blocks_prop.clone());

        let mut explain_props = Map::new();
        explain_props.insert("pair".into(), pair_prop.clone());
        explain_props.insert("blocks".into(), blocks_prop.clone());

        let mut recent_props = Map::new();
        recent_props.insert("pair".into(), pair_prop);
        recent_props.insert("blocks".into(), blocks_prop);
        recent_props.insert(
            "limit".into(),
            json!({ "type": "integer", "description": "Max swaps to return (1-100, default 10)." }),
        );

        vec![
            Tool::new(
                "get_sentiment".to_string(),
                "Current flow sentiment for a pair, computed from the most recent blocks \
                 on demand: net flow, volume- and count-weighted imbalance, trend vs the \
                 preceding blocks, participation, and a label. Returns INSUFFICIENT_DATA \
                 when too few swaps to be meaningful."
                    .to_string(),
                object_schema(sentiment_props, &["pair"]),
            ),
            Tool::new(
                "explain_sentiment".to_string(),
                "The same reading as get_sentiment, rendered as a plain-language \
                 explanation including what would change the read and the standing \
                 caveats. Deterministically generated from the numbers."
                    .to_string(),
                object_schema(explain_props, &["pair"]),
            ),
            Tool::new(
                "get_recent_swaps".to_string(),
                "Individual recent swaps behind the aggregate — tx hash, side, USDC \
                 notional, sender, block. Use these receipts to verify any reported \
                 figure against a block explorer."
                    .to_string(),
                object_schema(recent_props, &["pair"]),
            ),
            Tool::new(
                "list_pairs".to_string(),
                "Pairs this server can report on.".to_string(),
                object_schema(Map::new(), &[]),
            ),
        ]
    }

    // ── tool implementations ────────────────────────────────────────────────────

    /// Pull, split into two windows, and aggregate.
    ///
    /// Fetches 2x the requested blocks in ONE call so the older half can serve as the
    /// previous window for the trend metric. Two separate pulls would double the
    /// latency and risk the ranges drifting apart as the head advances.
    async fn snapshot(&self, args: &Map<String, Value>) -> Result<(SentimentSnapshot, PullMeta)> {
        let pair = require_pair(args)?;
        let blocks = parse_blocks(args)?;

        let cfg = PullConfig::from_env();
        let result = pull_recent_swaps(&cfg, blocks * 2).await?;

        let for_pair: Vec<_> = result
            .swaps
            .iter()
            .filter(|s| s.pair == pair)
            .cloned()
            .collect();

        // Boundary between the current window and the preceding one.
        let split = result.to_block.saturating_sub(blocks);
        let snap =
            SentimentSnapshot::from_split(&pair, blocks_to_minutes(blocks), &for_pair, split);

        Ok((
            snap,
            PullMeta {
                blocks,
                from_block: split,
                to_block: result.to_block,
                elapsed_ms: result.elapsed_ms,
            },
        ))
    }

    async fn handle_get_sentiment(&self, args: &Map<String, Value>) -> Result<String> {
        let (snap, meta) = self.snapshot(args).await?;
        Ok(json!({
            "pair": snap.pair,
            "blocksAnalysed": meta.blocks,
            "fromBlock": meta.from_block,
            "toBlock": meta.to_block,
            "approxWindowMinutes": snap.window_minutes,
            "sentiment": snap.sentiment.as_str(),
            "netFlowUsdc": round2(snap.net_flow_usdc),
            "buyVolumeUsdc": round2(snap.buy_volume_usdc),
            "sellVolumeUsdc": round2(snap.sell_volume_usdc),
            "imbalance": snap.imbalance.map(round4),
            "imbalanceByCount": snap.imbalance_by_count.map(round4),
            "trend": snap.trend.map(round4),
            "previousImbalance": snap.previous_imbalance.map(round4),
            "swapCount": snap.swap_count,
            "buyCount": snap.buy_count,
            "sellCount": snap.sell_count,
            "uniqueSenders": snap.unique_senders,
            "participationFloor": PARTICIPATION_FLOOR,
            "whaleDivergence": snap.whale_divergence(),
            "latestBlock": snap.latest_block,
            "secondsSinceLatestSwap": snap.seconds_since_latest_swap,
            "fetchMs": meta.elapsed_ms,
            "caveats": CAVEAT,
        })
        .to_string())
    }

    async fn handle_explain_sentiment(&self, args: &Map<String, Value>) -> Result<String> {
        let (snap, meta) = self.snapshot(args).await?;
        Ok(json!({
            "pair": snap.pair,
            "blocksAnalysed": meta.blocks,
            "fromBlock": meta.from_block,
            "toBlock": meta.to_block,
            "sentiment": snap.sentiment.as_str(),
            "explanation": snap.explain(),
        })
        .to_string())
    }

    async fn handle_get_recent_swaps(&self, args: &Map<String, Value>) -> Result<String> {
        let pair = require_pair(args)?;
        let blocks = parse_blocks(args)?;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(10)
            .clamp(1, 100) as usize;

        let cfg = PullConfig::from_env();
        let result = pull_recent_swaps(&cfg, blocks).await?;

        let mut for_pair: Vec<_> = result.swaps.iter().filter(|s| s.pair == pair).collect();
        for_pair.sort_by(|a, b| b.block().cmp(&a.block()).then(b.log_index.cmp(&a.log_index)));

        let items: Vec<Value> = for_pair
            .into_iter()
            .take(limit)
            .map(|s| {
                json!({
                    "txHash": s.tx_hash,
                    "logIndex": s.log_index,
                    "side": s.side,
                    "usdcNotional": round2(s.notional()),
                    "sender": s.sender,
                    "blockNumber": s.block(),
                })
            })
            .collect();

        Ok(json!({
            "pair": pair,
            "fromBlock": result.from_block,
            "toBlock": result.to_block,
            "swaps": items,
            "note": "`sender` is usually a router or settlement contract, not the end trader.",
        })
        .to_string())
    }

    async fn handle_list_pairs(&self) -> Result<String> {
        // Fixed set: these are the pools the Substreams module tracks. Reporting them
        // from a constant rather than from observed data means an empty market cannot
        // make a pair look unsupported.
        Ok(json!({
            "pairs": ["WETH/USDC"],
            "note": "Uniswap V3 WETH/USDC 0.05% on Ethereum mainnet — the dominant tier for the pair.",
        })
        .to_string())
    }

    async fn call(&self, tool: &str, args: &Map<String, Value>) -> Result<String> {
        match tool {
            "get_sentiment" => self.handle_get_sentiment(args).await,
            "explain_sentiment" => self.handle_explain_sentiment(args).await,
            "get_recent_swaps" => self.handle_get_recent_swaps(args).await,
            "list_pairs" => self.handle_list_pairs().await,
            other => Err(anyhow::anyhow!("unknown tool: {other}")),
        }
    }

    /// JSON-RPC dispatch used by the HTTP registry transport.
    pub async fn dispatch(&self, body: Value) -> Value {
        let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = body.get("id").cloned();
        let params = body.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => json_rpc_ok(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "orloj-feeling-mcp", "version": "2.0.0" },
                    "instructions": Self::instructions(),
                }),
            ),
            "notifications/initialized" | "notifications/cancelled" => Value::Null,
            "ping" => json_rpc_ok(id, json!({})),
            "tools/list" => json_rpc_ok(id, json!({ "tools": Self::tools() })),
            "tools/call" => {
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args: Map<String, Value> = params
                    .get("arguments")
                    .and_then(|a| a.as_object())
                    .cloned()
                    .unwrap_or_default();

                let result = self.call(tool_name, &args).await;

                if let Some(db) = &self.db
                    && let Some(agent_id) = &self.agent_id
                {
                    let (status, err) = match &result {
                        Ok(_) => ("ok", None),
                        Err(e) => ("error", Some(format!("{e:#}"))),
                    };
                    db.log_tool_call(
                        agent_id,
                        "feeling",
                        Some("OnchainSentiment"),
                        tool_name,
                        Some(&Value::Object(args.clone())),
                        status,
                        None,
                        err.as_deref(),
                    )
                    .await;
                }

                json_rpc_ok(
                    id,
                    match result {
                        Ok(text) => json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": false,
                        }),
                        Err(e) => json!({
                            "content": [{ "type": "text", "text": format!("{e:#}") }],
                            "isError": true,
                        }),
                    },
                )
            }
            _ => json_rpc_error(id, -32601, format!("method not found: {method}")),
        }
    }
}

struct PullMeta {
    blocks: u64,
    from_block: u64,
    to_block: u64,
    elapsed_ms: u128,
}

// ── argument parsing ────────────────────────────────────────────────────────────

fn require_pair(args: &Map<String, Value>) -> Result<String> {
    let pair = args
        .get("pair")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing 'pair' argument — call list_pairs to see options"))?
        .trim();
    if pair.is_empty() {
        anyhow::bail!("'pair' must be a non-empty string");
    }
    Ok(pair.to_uppercase())
}

/// Parse and clamp the block count. Accepts a JSON number or numeric string, since MCP
/// clients differ on how they render integer-typed properties.
fn parse_blocks(args: &Map<String, Value>) -> Result<u64> {
    let raw = match args.get("blocks") {
        None | Some(Value::Null) => return Ok(DEFAULT_BLOCKS),
        Some(Value::String(s)) => s
            .trim()
            .parse::<u64>()
            .context("blocks must be a positive integer")?,
        Some(v) => v
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("blocks must be a positive integer"))?,
    };
    Ok(raw.clamp(MIN_BLOCKS, MAX_BLOCKS))
}

fn object_schema(props: Map<String, Value>, required: &[&str]) -> Map<String, Value> {
    let mut schema = Map::new();
    schema.insert("type".into(), Value::String("object".into()));
    schema.insert("properties".into(), Value::Object(props));
    if !required.is_empty() {
        schema.insert(
            "required".into(),
            Value::Array(required.iter().map(|s| Value::String((*s).into())).collect()),
        );
    }
    schema
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

fn json_rpc_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Option<Value>, code: i32, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ── ServerHandler (stdio transport) ─────────────────────────────────────────────

impl ServerHandler for FeelingMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            instructions: Some(Self::instructions().to_string()),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: Self::tools(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = request.arguments.unwrap_or_default();
        Ok(match self.call(request.name.as_ref(), &args).await {
            Ok(text) => CallToolResult::success(vec![Content::text(text)]),
            Err(e) => CallToolResult::error(vec![Content::text(format!("{e:#}"))]),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcps::feeling::pull::parse_jsonl;

    fn args(json: Value) -> Map<String, Value> {
        json.as_object().cloned().unwrap()
    }

    #[test]
    fn blocks_default_and_clamp() {
        assert_eq!(parse_blocks(&args(json!({}))).unwrap(), DEFAULT_BLOCKS);
        assert_eq!(parse_blocks(&args(json!({"blocks": 500}))).unwrap(), 500);
        assert_eq!(parse_blocks(&args(json!({"blocks": "500"}))).unwrap(), 500);
        assert_eq!(parse_blocks(&args(json!({"blocks": 1}))).unwrap(), MIN_BLOCKS);
        assert_eq!(
            parse_blocks(&args(json!({"blocks": 999_999}))).unwrap(),
            MAX_BLOCKS
        );
    }

    #[test]
    fn pair_is_required_and_normalised() {
        assert!(require_pair(&args(json!({}))).is_err());
        assert!(require_pair(&args(json!({"pair": "  "}))).is_err());
        assert_eq!(
            require_pair(&args(json!({"pair": "weth/usdc"}))).unwrap(),
            "WETH/USDC"
        );
    }

    #[test]
    fn block_count_maps_to_a_sensible_window() {
        assert_eq!(blocks_to_minutes(200), 40); // 200 * 12s = 40 min
        assert_eq!(blocks_to_minutes(100), 20);
    }

    #[test]
    fn split_produces_a_trend_from_one_pull() {
        // Two windows either side of block 1100: current is buy-heavy, previous
        // sell-heavy, so trend must be strongly positive.
        let line = |blk: u64, side: &str, amt: &str, idx: u32| {
            format!(
                r#"{{"@data":{{"swaps":[{{"pool":"0xp","pair":"WETH/USDC","blockNumber":"{blk}","blockHash":"h","timestamp":"1700000000","txHash":"0x{idx}","logIndex":{idx},"sender":"0xs{idx}","recipient":"0xr","amount0":"1","amount1":"-1","side":"{side}","usdcNotional":"{amt}"}}]}}}}"#
            )
        };
        let mut lines = Vec::new();
        // previous window (blocks < 1100): mostly sells
        for i in 0..12 {
            lines.push(line(1000 + i, "SELL", "1000", i as u32));
        }
        // current window (blocks >= 1100): mostly buys
        for i in 0..12 {
            lines.push(line(1100 + i, "BUY", "1000", 100 + i as u32));
        }
        let swaps = parse_jsonl(&lines.join("\n"));
        assert_eq!(swaps.len(), 24);

        let snap = SentimentSnapshot::from_split("WETH/USDC", 40, &swaps, 1100);
        assert_eq!(snap.swap_count, 12);
        assert_eq!(snap.imbalance, Some(1.0)); // all buys now
        assert_eq!(snap.previous_imbalance, Some(-1.0)); // all sells before
        assert_eq!(snap.trend, Some(2.0));
    }

    #[test]
    fn no_previous_window_means_no_trend_not_a_fake_zero() {
        let line = r#"{"@data":{"swaps":[{"pool":"0xp","pair":"WETH/USDC","blockNumber":"1200","blockHash":"h","timestamp":"1700000000","txHash":"0x1","logIndex":1,"sender":"0xs","recipient":"0xr","amount0":"1","amount1":"-1","side":"BUY","usdcNotional":"500"}]}}"#;
        let swaps = parse_jsonl(line);
        let snap = SentimentSnapshot::from_split("WETH/USDC", 40, &swaps, 1100);
        assert_eq!(snap.trend, None);
        assert_eq!(snap.previous_imbalance, None);
    }

    #[tokio::test]
    async fn tools_are_listed_and_initialize_carries_honesty_instructions() {
        let server = FeelingMcpServer::new(None, None);
        let tools = server
            .dispatch(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .await;
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 4);

        let init = server
            .dispatch(json!({"jsonrpc":"2.0","id":1,"method":"initialize"}))
            .await;
        let instr = init["result"]["instructions"].as_str().unwrap();
        assert!(instr.contains("READ-ONLY"));
        assert!(instr.contains("mempool"));
        assert!(instr.contains("on demand"));
    }

    #[tokio::test]
    async fn list_pairs_works_without_any_network_or_db() {
        let server = FeelingMcpServer::new(None, None);
        let resp = server
            .dispatch(json!({
                "jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":"list_pairs","arguments":{}}
            }))
            .await;
        assert_eq!(resp["result"]["isError"], false);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("WETH/USDC"));
    }
}
