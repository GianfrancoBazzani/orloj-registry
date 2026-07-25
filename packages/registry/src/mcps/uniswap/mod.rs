// Chain-agnostic MCP wrapping the Uniswap APIs.
//
// Unlike EvmMcpServer/NativeMcpServer, this server is not bound to a single chain at
// construction time: `chainId` is a required tool argument on every call so it's never
// ambiguous which network is targeted. Anything that signs needs an rpc_url — always
// resolved from the `networks` table by chainId (db::DbPool::get_network), never accepted
// as a tool argument. `supported_networks` lists what's registered there.
//
// Two distinct Uniswap services are wrapped here, and they are not interchangeable:
//   the Trading API   (trade-api.gateway.uniswap.org/v1) for swaps, any registered chain
//   the Liquidity API (liquidity.api.uniswap.org)        for V3 LP positions, Sepolia only
//
// Module layout:
//   common   – argument parsing, Trading API base URL, receipt polling
//   permit2  – Permit2 EIP-712 digest computation and vault-backed digest signing
//   trading  – Uniswap Trading API: `quote`, `swap`, `supported_networks`
//   lp       – Uniswap Liquidity API + on-chain V3 reads: `get_v3_position`,
//              `create_v3_position`, `decrease_v3_position`, `claim_v3_fees`
//
// Env vars:
//   UNISWAP_API_KEY     – Uniswap API key, shared by both APIs (required)
//   UNISWAP_API_URL     – Trading API base URL (default: https://trade-api.gateway.uniswap.org/v1)
//   UNISWAP_LP_API_URL  – Liquidity API base URL (default: https://liquidity.api.uniswap.org)
//   ONECLAW_API_KEY / ONECLAW_BASE_URL                                   – needed only if the
//     agent's vault is 1Claw-backed (ONECLAW_BASE_URL has a default; ONECLAW_API_KEY doesn't)
//   ORBITPORT_CLIENT_ID / ORBITPORT_CLIENT_SECRET / ORBITPORT_API_URL    – needed only if the
//     agent's vault is Orbitport-backed (via orbitport_access_token() in vault::sign_transaction;
//     CLIENT_ID/CLIENT_SECRET have no defaults, API_URL does)

mod common;
mod lp;
mod permit2;
mod trading;

use std::sync::Arc;

use anyhow::Result;
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value, json};

use crate::db::DbPool;
use lp::build_uniswap_lp_tools;
use trading::build_uniswap_tools;

const INSTRUCTIONS: &str = "Uniswap swaps and Uniswap V3 liquidity positions. \
Every call takes an explicit chainId so token addresses are never ambiguous across networks. \
All tools act on the authenticated agent's own wallet, resolved automatically from its vault — \
you never supply a wallet address, a private key, an rpc_url, or manage nonces/gas yourself. \
Every write tool signs and broadcasts automatically and waits for the transaction to confirm; \
there is no separate approval or submission step for you to call. \
\
These are two different Uniswap services. SWAPS use the Trading API and work on any registered \
chain: supported_networks() lists the chainIds with an rpc_url configured. \
quote(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) returns pricing and routing \
with no side effects. swap(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) fetches \
a quote, transparently handles both Permit2 layers if needed, then signs and broadcasts. \
\
LIQUIDITY uses the separate Uniswap Liquidity API and is ETHEREUM SEPOLIA ONLY (chainId \
11155111); any other chainId is rejected. Uniswap V3 only — not V2, not V4. Contracts used: \
UniswapV3Factory 0x0227628f3F023bb0B980b67D528571c95c6DaC1c and NonfungiblePositionManager \
0x1238536071E1c677A632429e3655c799b22cDA52. Every liquidity tool refuses to act on a position \
NFT the agent's wallet does not own. \
get_v3_position(chainId, nftTokenId) reads a position — pool, token pair, fee tier, tick range, \
liquidity and uncollected fees. Read-only, on-chain only, no side effects. \
create_v3_position(chainId, poolAddress, independentTokenAddress, independentTokenAmount, \
tickLower, tickUpper, slippageTolerance?) opens a position in an EXISTING pool; it cannot create \
a pool. Give one side of the pair and Uniswap derives the other. The pool's token0/token1 are \
read from the pool itself and verified against the factory, so you do not pass them. It runs any \
required token approvals first, waits for each to confirm, then mints, and returns the \
transaction hash plus the new position NFT's token id. \
decrease_v3_position(chainId, nftTokenId, liquidityPercentageToDecrease, slippageTolerance?) \
withdraws liquidity; pass 100 to close the position out. It does not open a replacement position \
and does not claim fees. \
claim_v3_fees(chainId, nftTokenId) sweeps accrued trading fees and leaves liquidity untouched. \
Decrease and claim withdraw any ETH side as WETH. \
\
The agent's Sepolia vault must be funded with gas and with the tokens being deposited before any \
liquidity write will succeed. On failure, the error names the stage that failed (position read, \
API request, approval, simulation, broadcast or receipt); if approvals were already broadcast \
before the failure, their transaction hashes are listed in the error.";

// ---------------------------------------------------------------------------
// Config & server struct
// ---------------------------------------------------------------------------

pub struct UniswapMcpConfig {
    pub agent_id: Option<String>,
    pub db: Option<Arc<DbPool>>,
}

#[derive(Clone)]
pub struct UniswapMcpServer {
    http: reqwest::Client,
    agent_id: Option<String>,
    db: Option<Arc<DbPool>>,
}

impl UniswapMcpServer {
    pub fn new(agent_id: Option<String>, db: Option<Arc<DbPool>>) -> Self {
        Self {
            http: reqwest::Client::new(),
            agent_id,
            db,
        }
    }

    /// Builds the tool list fresh on every call, so `chainId`'s enum (see build_chain_id_prop)
    /// always reflects the current `networks` table instead of a snapshot taken at construction.
    async fn tools(&self) -> Vec<Tool> {
        let networks = match &self.db {
            Some(db) => db.list_networks().await.unwrap_or_default(),
            _none => Vec::new(),
        };
        let mut tools = build_uniswap_tools(&networks);
        tools.extend(build_uniswap_lp_tools());
        tools
    }

    /// Single tool-name → handler table, shared by the HTTP and stdio transports.
    async fn call(&self, tool_name: &str, args: &Map<String, Value>) -> Result<String> {
        match tool_name {
            "quote" => self.handle_quote(args).await,
            "swap" => self.handle_swap(args).await,
            "supported_networks" => self.handle_supported_networks().await,
            "get_v3_position" => self.handle_get_v3_position(args).await,
            "create_v3_position" => self.handle_create_v3_position(args).await,
            "decrease_v3_position" => self.handle_decrease_v3_position(args).await,
            "claim_v3_fees" => self.handle_claim_v3_fees(args).await,
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
                    "serverInfo": {
                        "name": "uniswap-mcp",
                        "version": "1.0.0",
                    },
                    "instructions": INSTRUCTIONS,
                }),
            ),
            "notifications/initialized" | "notifications/cancelled" => Value::Null,
            "ping" => json_rpc_ok(id, json!({})),
            "tools/list" => json_rpc_ok(id, json!({ "tools": self.tools().await })),
            "tools/call" => {
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args: Map<String, Value> = params
                    .get("arguments")
                    .and_then(|a| a.as_object())
                    .cloned()
                    .unwrap_or_default();

                json_rpc_ok(
                    id,
                    match self.call(tool_name, &args).await {
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

fn json_rpc_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Option<Value>, code: i32, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

// ---------------------------------------------------------------------------
// ServerHandler impl — stdio transport
// ---------------------------------------------------------------------------

impl ServerHandler for UniswapMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            instructions: Some(INSTRUCTIONS.to_string()),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: self.tools().await,
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

// ---------------------------------------------------------------------------
// Entry point for the stdio uniswap-mcp binary
// ---------------------------------------------------------------------------

pub async fn run_uniswap_mcp(cfg: UniswapMcpConfig) -> Result<()> {
    let server = UniswapMcpServer::new(cfg.agent_id, cfg.db);

    eprintln!("[uniswap-mcp] ready: chain-agnostic (chainId supplied per call)");

    server.serve(stdio()).await?.waiting().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A server with no agent and no database. `tools()` handles a missing db by falling back to
    /// an empty network list, so the whole tool surface is listable without any infrastructure.
    fn offline_server() -> UniswapMcpServer {
        UniswapMcpServer::new(None, None)
    }

    fn tool_names(result: &Value) -> Vec<String> {
        result["result"]["tools"]
            .as_array()
            .expect("tools/list should return an array")
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn tools_list_exposes_the_swap_and_liquidity_tools() {
        let result = offline_server()
            .dispatch(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
            .await;

        let names = tool_names(&result);
        for expected in [
            "quote",
            "swap",
            "supported_networks",
            "get_v3_position",
            "create_v3_position",
            "decrease_v3_position",
            "claim_v3_fees",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "tools/list should contain {expected}, got {names:?}"
            );
        }
        assert_eq!(names.len(), 7, "no unexpected tools: {names:?}");
    }

    #[tokio::test]
    async fn every_listed_tool_is_dispatchable() {
        // A tool advertised by tools/list but missing from the dispatch table would only fail
        // at call time, for an agent that had every reason to believe it existed.
        let server = offline_server();
        let names = tool_names(
            &server
                .dispatch(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
                .await,
        );

        for name in names {
            let err = server
                .call(&name, &Map::new())
                .await
                .expect_err("no tool can succeed without an agent or db")
                .to_string();
            assert!(
                !err.contains("unknown tool"),
                "{name} is listed but not routed: {err}"
            );
        }
    }

    #[tokio::test]
    async fn unknown_tools_are_rejected() {
        let result = offline_server()
            .dispatch(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "increase_v3_position", "arguments": {}}
            }))
            .await;

        assert_eq!(result["result"]["isError"], json!(true));
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("unknown tool"), "got: {text}");
    }

    #[tokio::test]
    async fn initialize_describes_both_apis_and_the_sepolia_limit() {
        let result = offline_server()
            .dispatch(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}))
            .await;

        let instructions = result["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("Trading API"));
        assert!(instructions.contains("Liquidity API"));
        assert!(instructions.contains("11155111"));
        // The verified position manager, so the instructions can't drift from the code.
        assert!(instructions.contains("0x1238536071E1c677A632429e3655c799b22cDA52"));
    }

    #[tokio::test]
    async fn notifications_produce_no_response_body() {
        let result = offline_server()
            .dispatch(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        assert!(result.is_null());
    }
}
