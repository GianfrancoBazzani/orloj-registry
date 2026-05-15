use std::sync::Arc;

use crate::{
    abi_codec::{dyn_outputs_to_json, input_schema, json_to_dyn_args, value_to_text},
    db::DbPool,
    vault::sign_transaction::{SignTransactionParams, sign_transaction},
};
use alloy::{
    dyn_abi::{FunctionExt, JsonAbiExt},
    json_abi::{Function, JsonAbi, StateMutability},
    network::Ethereum,
    primitives::{Address, U256},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
};
use anyhow::{Context, Result};
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value};

pub struct EvmMcpConfig {
    pub abi: JsonAbi,
    pub address: Address,
    pub chain_id: u64,
    pub rpc_url: String,
    pub agent_id: Option<String>,
    /// Database pool for vault resolution (write calls). None for stdio-only use.
    pub db: Option<Arc<DbPool>>,
}

pub struct EvmMcpServer<P> {
    abi: Arc<JsonAbi>,
    tools: Arc<Vec<Tool>>,
    address: Address,
    chain_id: u64,
    rpc_url: String,
    provider: Arc<P>,
    agent_id: Option<String>,
    db: Option<Arc<DbPool>>,
}

impl<P> EvmMcpServer<P> {
    pub fn new(
        abi: Arc<JsonAbi>,
        tools: Arc<Vec<Tool>>,
        address: Address,
        chain_id: u64,
        rpc_url: String,
        provider: Arc<P>,
        agent_id: Option<String>,
        db: Option<Arc<DbPool>>,
    ) -> Self {
        Self {
            abi,
            tools,
            address,
            chain_id,
            rpc_url,
            provider,
            agent_id,
            db,
        }
    }
}

impl<P> Clone for EvmMcpServer<P> {
    fn clone(&self) -> Self {
        Self {
            abi: Arc::clone(&self.abi),
            tools: Arc::clone(&self.tools),
            address: self.address,
            chain_id: self.chain_id,
            rpc_url: self.rpc_url.clone(),
            provider: Arc::clone(&self.provider),
            agent_id: self.agent_id.clone(),
            db: self.db.clone(),
        }
    }
}

pub fn is_view(f: &Function) -> bool {
    matches!(
        f.state_mutability,
        StateMutability::View | StateMutability::Pure
    )
}

pub fn build_tools(abi: &JsonAbi) -> Vec<Tool> {
    let mut seen = std::collections::HashSet::new();
    abi.functions()
        .filter(|f| seen.insert(f.name.clone()))
        .map(|f| Tool::new(f.name.clone(), f.name.clone(), input_schema(f, !is_view(f))))
        .collect()
}

impl<P: Provider<Ethereum> + Send + Sync + 'static> EvmMcpServer<P> {
    async fn call_view(&self, func: &Function, args: &Map<String, Value>) -> Result<String> {
        let calldata = func
            .abi_encode_input(&json_to_dyn_args(func, args)?)
            .context("failed to encode calldata")?;

        let tx = TransactionRequest::default()
            .to(self.address)
            .input(calldata.into());

        let raw = self.provider.call(tx).await.context("eth_call failed")?;

        let decoded = func
            .abi_decode_output(&raw)
            .context("failed to decode output")?;

        Ok(value_to_text(dyn_outputs_to_json(&decoded, func)))
    }

    async fn call_write(&self, func: &Function, args: &Map<String, Value>) -> Result<String> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("write call requires an authenticated agent"))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("write calls require a database connection"))?;

        let value_wei = args
            .get("native_gas_token_value")
            .and_then(|v| v.as_str())
            .map(|s| U256::from_str_radix(s, 10))
            .transpose()
            .context("invalid native_gas_token_value — must be wei as decimal string")?
            .unwrap_or(U256::ZERO);

        let mut contract_args = args.clone();
        contract_args.remove("native_gas_token_value");

        let calldata = func
            .abi_encode_input(&json_to_dyn_args(func, &contract_args)?)
            .context("failed to encode calldata")?;

        let signed = sign_transaction(
            db,
            SignTransactionParams {
                agent_id: agent_id.to_string(),
                chain_id: self.chain_id,
                rpc_url: self.rpc_url.clone(),
                to: self.address,
                value: value_wei,
                data: calldata.into(),
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

        Ok(format!("{:#x}", pending.tx_hash()))
    }

    /// Handle a single MCP JSON-RPC request and return the JSON-RPC response.
    /// Used by the HTTP transport in the registry server.
    /// Returns serde_json::Value::Null for notifications (no response body needed).
    pub async fn dispatch(&self, body: Value) -> Value {
        let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = body.get("id").cloned();
        let params = body.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => json_rpc_ok(
                id,
                serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "orloj-evm-mcp", "version": "1.0.0" },
                }),
            ),

            // Notification — caller should send 202 No Content
            "notifications/initialized" | "notifications/cancelled" => Value::Null,

            "ping" => json_rpc_ok(id, serde_json::json!({})),

            "tools/list" => json_rpc_ok(id, serde_json::json!({ "tools": &*self.tools })),

            "tools/call" => {
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args: Map<String, Value> = params
                    .get("arguments")
                    .and_then(|a| a.as_object())
                    .cloned()
                    .unwrap_or_default();

                let func = match self.abi.function(tool_name).and_then(|fs| fs.first()) {
                    Some(f) => f,
                    None => {
                        return json_rpc_ok(
                            id,
                            serde_json::json!({
                                "content": [{ "type": "text", "text": format!("unknown tool: {tool_name}") }],
                                "isError": true,
                            }),
                        );
                    }
                };

                let result = if is_view(func) {
                    self.call_view(func, &args).await
                } else {
                    self.call_write(func, &args).await
                };

                json_rpc_ok(
                    id,
                    match result {
                        Ok(text) => serde_json::json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": false,
                        }),
                        Err(e) => serde_json::json!({
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
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Option<Value>, code: i32, message: String) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

// ---------------------------------------------------------------------------
// ServerHandler impl — used by the stdio evm-mcp binary
// ---------------------------------------------------------------------------

impl<P: Provider<Ethereum> + Send + Sync + 'static> ServerHandler for EvmMcpServer<P> {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
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
        let func = self
            .abi
            .function(&request.name)
            .and_then(|fs| fs.first())
            .ok_or_else(|| {
                McpError::invalid_params(format!("unknown function: {}", request.name), None)
            })?;

        let args = request.arguments.unwrap_or_default();

        let result = if is_view(func) {
            self.call_view(func, &args).await
        } else {
            self.call_write(func, &args).await
        };

        Ok(match result {
            Ok(text) => CallToolResult::success(vec![Content::text(text)]),
            Err(e) => CallToolResult::error(vec![Content::text(format!("{e:#}"))]),
        })
    }
}

// ---------------------------------------------------------------------------
// Entry point for the stdio evm-mcp binary
// ---------------------------------------------------------------------------

pub async fn run_evm_mcp(cfg: EvmMcpConfig) -> Result<()> {
    let t0 = std::time::Instant::now();

    let provider = ProviderBuilder::new()
        .connect(&cfg.rpc_url)
        .await
        .context("rpc connect failed")?;
    let abi = Arc::new(cfg.abi);
    let tools = build_tools(&abi);

    eprintln!(
        "[evm-mcp] ready: {} tools built in {:?} (address={})",
        tools.len(),
        t0.elapsed(),
        cfg.address
    );

    let server = EvmMcpServer::new(
        abi,
        Arc::new(tools),
        cfg.address,
        cfg.chain_id,
        cfg.rpc_url.clone(),
        Arc::new(provider),
        cfg.agent_id,
        cfg.db,
    );
    server.serve(stdio()).await?.waiting().await?;
    Ok(())
}
