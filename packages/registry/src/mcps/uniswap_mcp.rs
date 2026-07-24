// Chain-agnostic MCP wrapping the Uniswap Trading API
// (https://trade-api.gateway.uniswap.org/v1 — see developers.uniswap.org/docs/trading/swapping-api).
//
// Unlike EvmMcpServer/NativeMcpServer, this server is not bound to a single chain at
// construction time: `chainId` (and, for `swap`, `rpcUrl`) are required tool arguments so
// every call is unambiguous about which network it targets.
//
// `quote` is a read-only call to Uniswap's /quote endpoint — no wallet/signing needed beyond
// the `swapper` address supplied by the caller.
//
// `swap` resolves the authenticated agent's own wallet address (via the vault, no raw keys),
// fetches a quote for that swapper, requests the built transaction from /swap, then signs and
// broadcasts it through the same vault-signing path as EvmMcpServer write calls. Routes that
// require an off-chain Permit2 signature (ERC-20 input without a standing Permit2 allowance)
// are not supported — Uniswap's error response is surfaced with a pointer to /check_approval.
//
// Env vars:
//   UNISWAP_API_KEY  – Uniswap Trading API key (required)
//   UNISWAP_API_URL  – base URL (default: https://trade-api.gateway.uniswap.org/v1)

use std::sync::Arc;

use alloy::{
    primitives::{Address, Bytes, U256},
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
    vault::sign_transaction::{SignTransactionParams, resolve_agent_address, sign_transaction},
};

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
    tools: Arc<Vec<Tool>>,
}

impl UniswapMcpServer {
    pub fn new(agent_id: Option<String>, db: Option<Arc<DbPool>>) -> Self {
        Self {
            http: reqwest::Client::new(),
            agent_id,
            db,
            tools: Arc::new(build_uniswap_tools()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

pub fn build_uniswap_tools() -> Vec<Tool> {
    let chain_id_prop = json!({
        "type": "integer",
        "description": "EVM chain ID for both the input and output token (e.g. 1 = Ethereum Mainnet, 137 = Polygon, 8453 = Base, 42161 = Arbitrum One). Required on every call so the swap is never ambiguous about which network it targets."
    });
    let token_in_prop = json!({
        "type": "string",
        "description": "Input token address (0x-prefixed 20-byte hex) on `chainId`. Use 0x0000000000000000000000000000000000000000 for the chain's native currency (ETH, MATIC, BNB, ...)."
    });
    let token_out_prop = json!({
        "type": "string",
        "description": "Output token address (0x-prefixed 20-byte hex) on `chainId`. Same native-currency convention as tokenIn."
    });
    let amount_prop = json!({
        "type": "string",
        "description": "Amount in the token's smallest unit (wei), as a decimal string. For type=EXACT_INPUT this is the tokenIn amount; for type=EXACT_OUTPUT it is the desired tokenOut amount."
    });
    let type_prop = json!({
        "type": "string",
        "enum": ["EXACT_INPUT", "EXACT_OUTPUT"],
        "description": "Whether `amount` refers to the input or output token. Defaults to EXACT_INPUT."
    });
    let slippage_prop = json!({
        "type": "number",
        "description": "Maximum acceptable slippage in percent (e.g. 0.5 for 0.5%). Optional — Uniswap applies its own default if omitted."
    });

    let quote = Tool::new(
        "quote".to_string(),
        "Get a Uniswap price quote and route for a token pair on a given chain. Read-only — does not move funds.".to_string(),
        {
            let mut props = Map::new();
            props.insert("chainId".to_string(), chain_id_prop.clone());
            props.insert("tokenIn".to_string(), token_in_prop.clone());
            props.insert("tokenOut".to_string(), token_out_prop.clone());
            props.insert("amount".to_string(), amount_prop.clone());
            props.insert(
                "swapper".to_string(),
                json!({
                    "type": "string",
                    "description": "Wallet address (0x-prefixed) that would execute the swap. Required by Uniswap for accurate routing and pricing."
                }),
            );
            props.insert("type".to_string(), type_prop.clone());
            props.insert("slippageTolerance".to_string(), slippage_prop.clone());

            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(
                    ["chainId", "tokenIn", "tokenOut", "amount", "swapper"]
                        .into_iter()
                        .map(|s| Value::String(s.to_string()))
                        .collect(),
                ),
            );
            schema
        },
    );

    let swap = Tool::new(
        "swap".to_string(),
        "Execute a Uniswap swap on behalf of the authenticated agent. Fetches a quote for the agent's own wallet, builds the swap transaction via Uniswap, then signs and broadcasts it. Does not support routes requiring a fresh Permit2 signature (ERC-20 input without a standing Permit2 allowance) — approve the token to Permit2 on-chain first in that case.".to_string(),
        {
            let mut props = Map::new();
            props.insert("chainId".to_string(), chain_id_prop);
            props.insert(
                "rpcUrl".to_string(),
                json!({
                    "type": "string",
                    "description": "HTTPS or WSS RPC endpoint for `chainId`, used to sign and broadcast the swap transaction."
                }),
            );
            props.insert("tokenIn".to_string(), token_in_prop);
            props.insert("tokenOut".to_string(), token_out_prop);
            props.insert("amount".to_string(), amount_prop);
            props.insert("type".to_string(), type_prop);
            props.insert("slippageTolerance".to_string(), slippage_prop);

            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(
                    ["chainId", "rpcUrl", "tokenIn", "tokenOut", "amount"]
                        .into_iter()
                        .map(|s| Value::String(s.to_string()))
                        .collect(),
                ),
            );
            schema
        },
    );

    vec![quote, swap]
}

// ---------------------------------------------------------------------------
// Uniswap Trading API client helpers
// ---------------------------------------------------------------------------

fn uniswap_api_base() -> String {
    std::env::var("UNISWAP_API_URL")
        .unwrap_or_else(|_| "https://trade-api.gateway.uniswap.org/v1".to_string())
}

fn parse_flexible_u256(s: &str) -> Result<U256> {
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex) => U256::from_str_radix(hex, 16).context("invalid hex value in swap transaction"),
        _none => U256::from_str_radix(s, 10).context("invalid decimal value in swap transaction"),
    }
}

struct QuoteParams<'a> {
    chain_id: u64,
    token_in: &'a str,
    token_out: &'a str,
    amount: &'a str,
    swapper: &'a str,
    swap_type: &'a str,
    slippage: Option<f64>,
}

impl UniswapMcpServer {
    /// POST {base}/quote — mirrors the TS/Python examples in
    /// developers.uniswap.org/docs/trading/swapping-api/swapping-code-examples.
    async fn fetch_quote(&self, params: QuoteParams<'_>) -> Result<Value> {
        let api_key = std::env::var("UNISWAP_API_KEY").context("UNISWAP_API_KEY not set")?;

        let mut body = json!({
            "tokenIn": params.token_in,
            "tokenOut": params.token_out,
            "tokenInChainId": params.chain_id,
            "tokenOutChainId": params.chain_id,
            "type": params.swap_type,
            "amount": params.amount,
            "swapper": params.swapper,
        });
        if let Some(s) = params.slippage {
            body["slippageTolerance"] = json!(s);
        }

        let resp = self
            .http
            .post(format!("{}/quote", uniswap_api_base()))
            .header("x-api-key", api_key)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .context("uniswap /quote request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("uniswap /quote returned {status}: {text}");
        }

        resp.json::<Value>()
            .await
            .context("uniswap /quote response is not JSON")
    }

    async fn handle_quote(&self, args: &Map<String, Value>) -> Result<String> {
        let chain_id = args
            .get("chainId")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("missing 'chainId' argument"))?;
        let token_in = args
            .get("tokenIn")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'tokenIn' argument"))?;
        let token_out = args
            .get("tokenOut")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'tokenOut' argument"))?;
        let amount = args
            .get("amount")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'amount' argument"))?;
        let swapper = args
            .get("swapper")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'swapper' argument"))?;
        let swap_type = args.get("type").and_then(|v| v.as_str()).unwrap_or("EXACT_INPUT");
        let slippage = args.get("slippageTolerance").and_then(|v| v.as_f64());

        let quote = self
            .fetch_quote(QuoteParams {
                chain_id,
                token_in,
                token_out,
                amount,
                swapper,
                swap_type,
                slippage,
            })
            .await?;

        Ok(quote.to_string())
    }

    async fn handle_swap(&self, args: &Map<String, Value>) -> Result<String> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("swap requires an authenticated agent"))?;
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("swap requires a database connection"))?;

        let chain_id = args
            .get("chainId")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("missing 'chainId' argument"))?;
        let rpc_url = args
            .get("rpcUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'rpcUrl' argument"))?;
        let token_in = args
            .get("tokenIn")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'tokenIn' argument"))?;
        let token_out = args
            .get("tokenOut")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'tokenOut' argument"))?;
        let amount = args
            .get("amount")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'amount' argument"))?;
        let swap_type = args.get("type").and_then(|v| v.as_str()).unwrap_or("EXACT_INPUT");
        let slippage = args.get("slippageTolerance").and_then(|v| v.as_f64());

        let swapper = resolve_agent_address(db, agent_id)
            .await
            .context("resolving agent wallet failed")?;

        let quote_resp = self
            .fetch_quote(QuoteParams {
                chain_id,
                token_in,
                token_out,
                amount,
                swapper: &swapper.to_string(),
                swap_type,
                slippage,
            })
            .await?;

        let quote = quote_resp
            .get("quote")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("uniswap /quote response missing 'quote' field: {quote_resp}"))?;

        let api_key = std::env::var("UNISWAP_API_KEY").context("UNISWAP_API_KEY not set")?;

        let swap_resp = self
            .http
            .post(format!("{}/swap", uniswap_api_base()))
            .header("x-api-key", &api_key)
            .header("Accept", "application/json")
            .json(&json!({ "quote": quote }))
            .send()
            .await
            .context("uniswap /swap request failed")?;

        if !swap_resp.status().is_success() {
            let status = swap_resp.status();
            let text = swap_resp.text().await.unwrap_or_default();
            anyhow::bail!(
                "uniswap /swap returned {status}: {text} — if this mentions a required Permit2 \
                 signature, the token needs a one-time on-chain Permit2 approval first \
                 (see https://developers.uniswap.org/docs/api-reference/check_approval)"
            );
        }

        let swap_json: Value = swap_resp
            .json()
            .await
            .context("uniswap /swap response is not JSON")?;

        let tx = swap_json
            .get("swap")
            .ok_or_else(|| anyhow::anyhow!("uniswap /swap response missing 'swap' field: {swap_json}"))?;

        let to: Address = tx
            .get("to")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("swap transaction missing 'to'"))?
            .parse()
            .context("invalid 'to' in swap transaction")?;

        let data: Bytes = tx
            .get("data")
            .and_then(|v| v.as_str())
            .unwrap_or("0x")
            .parse()
            .context("invalid 'data' in swap transaction")?;

        let value = tx
            .get("value")
            .and_then(|v| v.as_str())
            .map(parse_flexible_u256)
            .transpose()?
            .unwrap_or(U256::ZERO);

        let signed = sign_transaction(
            db,
            SignTransactionParams {
                agent_id: agent_id.to_string(),
                chain_id,
                rpc_url: rpc_url.to_string(),
                to,
                value,
                data,
                nonce: None,
            },
        )
        .await
        .context("signing swap transaction failed")?;

        let provider = ProviderBuilder::new()
            .connect(rpc_url)
            .await
            .context("rpc connect failed")?;

        let pending = provider
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
                        "name": "uniswap-mcp",
                        "version": "1.0.0",
                    },
                    "instructions": "Chain-agnostic Uniswap swaps. Every call takes an explicit chainId so token addresses are never ambiguous across networks. quote(chainId, tokenIn, tokenOut, amount, swapper, type?, slippageTolerance?) returns pricing and routing with no side effects. swap(chainId, rpcUrl, tokenIn, tokenOut, amount, type?, slippageTolerance?) resolves your agent's own wallet, fetches a quote, and signs + broadcasts the swap automatically — you do not provide private keys or manage nonces/gas yourself.",
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
                    "quote" => self.handle_quote(&args).await,
                    "swap" => self.handle_swap(&args).await,
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

impl ServerHandler for UniswapMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            instructions: Some(
                "Chain-agnostic Uniswap swaps. Every call takes an explicit chainId so token \
                 addresses are never ambiguous across networks. quote(...) returns pricing and \
                 routing with no side effects. swap(...) resolves your agent's own wallet, \
                 fetches a quote, and signs + broadcasts the swap automatically — you do not \
                 provide private keys or manage nonces/gas yourself."
                    .to_string(),
            ),
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
            "quote" => self.handle_quote(&args).await,
            "swap" => self.handle_swap(&args).await,
            other => Err(anyhow::anyhow!("unknown tool: {other}")),
        };

        Ok(match result {
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
