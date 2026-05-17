use std::sync::Arc;

use alloy::{
    network::Ethereum,
    primitives::{Address, U256},
    providers::{Provider, ProviderBuilder},
};
use anyhow::{Context, Result};
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value, json};

use crate::{
    db::DbPool,
    vault::sign_transaction::{SignTransactionParams, sign_transaction},
};

// ---------------------------------------------------------------------------
// Chain metadata — mirrors viem/chains nativeCurrency lookup (generate-mcp.js:57)
// ---------------------------------------------------------------------------

pub struct ChainInfo {
    pub name: &'static str,
    pub symbol: &'static str,
}

/// Look up chain name and native currency symbol by chain ID.
/// Falls back to ("Unknown Chain", "ETH") for unrecognised chain IDs.
pub fn chain_info(chain_id: u64) -> ChainInfo {
    match chain_id {
        1 => ChainInfo {
            name: "Ethereum Mainnet",
            symbol: "ETH",
        },
        10 => ChainInfo {
            name: "OP Mainnet",
            symbol: "ETH",
        },
        56 => ChainInfo {
            name: "BNB Smart Chain",
            symbol: "BNB",
        },
        66 => ChainInfo {
            name: "OKC",
            symbol: "OKT",
        },
        100 => ChainInfo {
            name: "Gnosis",
            symbol: "xDAI",
        },
        128 => ChainInfo {
            name: "Huobi ECO Chain",
            symbol: "HT",
        },
        137 => ChainInfo {
            name: "Polygon",
            symbol: "POL",
        },
        250 => ChainInfo {
            name: "Fantom Opera",
            symbol: "FTM",
        },
        255 => ChainInfo {
            name: "Kroma",
            symbol: "ETH",
        },
        321 => ChainInfo {
            name: "KCC",
            symbol: "KCS",
        },
        324 => ChainInfo {
            name: "zkSync Era",
            symbol: "ETH",
        },
        1088 => ChainInfo {
            name: "Metis Andromeda",
            symbol: "METIS",
        },
        1101 => ChainInfo {
            name: "Polygon zkEVM",
            symbol: "ETH",
        },
        1116 => ChainInfo {
            name: "Core",
            symbol: "CORE",
        },
        1284 => ChainInfo {
            name: "Moonbeam",
            symbol: "GLMR",
        },
        1285 => ChainInfo {
            name: "Moonriver",
            symbol: "MOVR",
        },
        2222 => ChainInfo {
            name: "Kava",
            symbol: "KAVA",
        },
        8453 => ChainInfo {
            name: "Base",
            symbol: "ETH",
        },
        34443 => ChainInfo {
            name: "Mode",
            symbol: "ETH",
        },
        42161 => ChainInfo {
            name: "Arbitrum One",
            symbol: "ETH",
        },
        42220 => ChainInfo {
            name: "Celo",
            symbol: "CELO",
        },
        43114 => ChainInfo {
            name: "Avalanche C-Chain",
            symbol: "AVAX",
        },
        59144 => ChainInfo {
            name: "Linea",
            symbol: "ETH",
        },
        60808 => ChainInfo {
            name: "BOB",
            symbol: "ETH",
        },
        81457 => ChainInfo {
            name: "Blast",
            symbol: "ETH",
        },
        534352 => ChainInfo {
            name: "Scroll",
            symbol: "ETH",
        },
        7777777 => ChainInfo {
            name: "Zora",
            symbol: "ETH",
        },
        1666600000 => ChainInfo {
            name: "Harmony One",
            symbol: "ONE",
        },
        _ => ChainInfo {
            name: "Unknown Chain",
            symbol: "ETH",
        },
    }
}

// ---------------------------------------------------------------------------
// Config & server struct
// ---------------------------------------------------------------------------

pub struct NativeMcpConfig {
    pub chain_id: u64,
    pub rpc_url: String,
    pub agent_id: Option<String>,
    pub db: Option<Arc<DbPool>>,
}

pub struct NativeMcpServer<P> {
    chain_id: u64,
    chain_name: &'static str,
    symbol: &'static str,
    rpc_url: String,
    provider: Arc<P>,
    agent_id: Option<String>,
    db: Option<Arc<DbPool>>,
    tools: Arc<Vec<Tool>>,
}

impl<P> NativeMcpServer<P> {
    pub fn new(
        chain_id: u64,
        rpc_url: String,
        provider: Arc<P>,
        agent_id: Option<String>,
        db: Option<Arc<DbPool>>,
    ) -> Self {
        let info = chain_info(chain_id);
        let tools = Arc::new(build_native_tools(info.symbol));
        Self {
            chain_id,
            chain_name: info.name,
            symbol: info.symbol,
            rpc_url,
            provider,
            agent_id,
            db,
            tools,
        }
    }
}

impl<P> Clone for NativeMcpServer<P> {
    fn clone(&self) -> Self {
        Self {
            chain_id: self.chain_id,
            chain_name: self.chain_name,
            symbol: self.symbol,
            rpc_url: self.rpc_url.clone(),
            provider: Arc::clone(&self.provider),
            agent_id: self.agent_id.clone(),
            db: self.db.clone(),
            tools: Arc::clone(&self.tools),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool list — mirrors generate-mcp.js buildNativeTokenServer
// ---------------------------------------------------------------------------

pub fn build_native_tools(symbol: &str) -> Vec<Tool> {
    let balance_of = Tool::new(
        "balanceOf".to_string(),
        format!("Get the native {symbol} balance of an address (in wei)"),
        {
            let mut props = Map::new();
            props.insert(
                "address".to_string(),
                json!({ "type": "string", "description": "Ethereum address (0x-prefixed 20-byte hex)" }),
            );
            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(vec![Value::String("address".to_string())]),
            );
            schema
        },
    );

    let transfer = Tool::new(
        "transfer".to_string(),
        format!("Transfer native {symbol} to an address"),
        {
            let mut props = Map::new();
            props.insert(
                "to".to_string(),
                json!({ "type": "string", "description": "Recipient address (0x-prefixed 20-byte hex)" }),
            );
            props.insert(
                "value".to_string(),
                json!({ "type": "string", "description": "Amount in wei (decimal string)" }),
            );
            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(vec![
                    Value::String("to".to_string()),
                    Value::String("value".to_string()),
                ]),
            );
            schema
        },
    );

    vec![balance_of, transfer]
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

impl<P: Provider<Ethereum> + Send + Sync + 'static> NativeMcpServer<P> {
    /// mirrors publicClient.getBalance({ address }) from generate-mcp.js
    async fn handle_balance_of(&self, args: &Map<String, Value>) -> Result<String> {
        let address: Address = args
            .get("address")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'address' argument"))?
            .parse()
            .context("invalid address")?;

        let balance = self
            .provider
            .get_balance(address)
            .await
            .context("eth_getBalance failed")?;

        Ok(json!({ "balance": balance.to_string() }).to_string())
    }

    /// mirrors signTransaction + publicClient.sendRawTransaction from generate-mcp.js
    async fn handle_transfer(&self, args: &Map<String, Value>) -> Result<String> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("transfer requires an authenticated agent"))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("transfer requires a database connection"))?;

        let to: Address = args
            .get("to")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'to' argument"))?
            .parse()
            .context("invalid 'to' address")?;

        let value_str = args
            .get("value")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'value' argument"))?;

        let value = U256::from_str_radix(value_str, 10)
            .context("invalid 'value' — must be wei as decimal string")?;

        let signed = sign_transaction(
            db,
            SignTransactionParams {
                agent_id: agent_id.to_string(),
                chain_id: self.chain_id,
                rpc_url: self.rpc_url.clone(),
                to,
                value,
                data: alloy::primitives::Bytes::new(),
                nonce: None,
            },
        )
        .await
        .context("signing failed")?;

        let pending = self
            .provider
            .send_raw_transaction(&signed)
            .await
            .context("eth_sendRawTransaction failed")?;

        Ok(json!({ "hash": format!("{:#x}", pending.tx_hash()) }).to_string())
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
                        "name": format!("native_token_chain_id_{}", self.chain_id),
                        "version": "1.0.0",
                        "instructions": "Key management is fully abstracted. You do not need to provide private keys, sign transactions, or manage wallets. Simply call the available tools — transactions are signed and broadcast automatically on your behalf."
                    },
                }),
            ),
            "notifications/initialized" | "notifications/cancelled" => Value::Null,
            "ping" => json_rpc_ok(id, json!({})),
            "tools/list" => json_rpc_ok(id, json!({ "tools": &*self.tools })),
            "tools/call" => {
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args: Map<String, Value> = params
                    .get("arguments")
                    .and_then(|a| a.as_object())
                    .cloned()
                    .unwrap_or_default();

                let result = match tool_name {
                    "balanceOf" => self.handle_balance_of(&args).await,
                    "transfer" => self.handle_transfer(&args).await,
                    other => Err(anyhow::anyhow!("unknown tool: {other}")),
                };

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

impl<P: Provider<Ethereum> + Send + Sync + 'static> ServerHandler for NativeMcpServer<P> {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            instructions: Some(format!(
                "This MCP provides direct access to native {symbol} token operations on {chain}. \
                 balanceOf(address) returns the {symbol} balance of any address in wei. \
                 transfer(to, value) sends {symbol} from the agent's wallet to any address. \
                 All amounts are in wei (decimal strings).",
                symbol = self.symbol,
                chain = self.chain_name,
            )),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: self.tools.as_ref().clone(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = request.arguments.unwrap_or_default();

        let result = match request.name.as_ref() {
            "balanceOf" => self.handle_balance_of(&args).await,
            "transfer" => self.handle_transfer(&args).await,
            other => Err(anyhow::anyhow!("unknown tool: {other}")),
        };

        Ok(match result {
            Ok(text) => CallToolResult::success(vec![Content::text(text)]),
            Err(e) => CallToolResult::error(vec![Content::text(format!("{e:#}"))]),
        })
    }
}

// ---------------------------------------------------------------------------
// Entry point for the stdio native-mcp binary
// ---------------------------------------------------------------------------

pub async fn run_native_mcp(cfg: NativeMcpConfig) -> Result<()> {
    let provider = ProviderBuilder::new()
        .connect(&cfg.rpc_url)
        .await
        .context("rpc connect failed")?;

    let server = NativeMcpServer::new(
        cfg.chain_id,
        cfg.rpc_url,
        Arc::new(provider),
        cfg.agent_id,
        cfg.db,
    );

    eprintln!(
        "[native-mcp] ready: chain={} ({}) symbol={}",
        server.chain_id, server.chain_name, server.symbol
    );

    server.serve(stdio()).await?.waiting().await?;
    Ok(())
}
