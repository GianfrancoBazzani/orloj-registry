// Chain-agnostic MCP wrapping the Uniswap APIs.
//
// Unlike EvmMcpServer/NativeMcpServer, this server is not bound to a single chain at
// construction time: `chainId` is a required tool argument on every call so it's never
// ambiguous which network is targeted. Anything that signs needs an rpc_url — always
// resolved from the `networks` table by chainId (db::DbPool::get_network), never accepted
// as a tool argument. `supported_networks` lists what's registered there.
//
// Module layout:
//   common   – argument parsing, Trading API base URL, receipt polling
//   permit2  – Permit2 EIP-712 digest computation and vault-backed digest signing
//   trading  – Uniswap Trading API: `quote`, `swap`, `supported_networks`
//
// Env vars:
//   UNISWAP_API_KEY  – Uniswap API key (required)
//   UNISWAP_API_URL  – Trading API base URL (default: https://trade-api.gateway.uniswap.org/v1)
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

const INSTRUCTIONS: &str = "Chain-agnostic Uniswap swaps. Every call takes an explicit chainId so token addresses are never ambiguous across networks. quote and swap act on the authenticated agent's own wallet, resolved automatically from its vault — you never supply a wallet/swapper address. supported_networks() lists the chainIds registered with an rpc_url (name + chainId) — swap only works on these. quote(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) returns pricing and routing for any Uniswap-supported chain, with no side effects. swap(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) resolves rpc_url from chainId automatically, fetches a quote, transparently handles Permit2 approval/signing if needed, and signs + broadcasts the swap — you do not provide private keys, an rpc_url, or manage nonces/gas yourself.";

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
