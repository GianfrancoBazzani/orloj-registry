// HTTP server — replicates the Express API from
// orloj-registry/packages/registry/src/server.mjs.

use std::sync::Arc;

use alloy::{json_abi::JsonAbi, primitives::Address, providers::ProviderBuilder};
use anyhow::Context;
use axum::{
    Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;

use crate::{
    auth::require_bearer,
    db::{DbPool, ContractMetaRow},
    mcps::{
        evm_mcp::{EvmMcpServer, build_tools},
        native_mcp::{NativeMcpServer, build_native_tools, chain_info},
    },
    registry::{McpEntry, McpMeta, Registry},
    sourcify::fetch_contract,
};

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub registry: Registry,
    pub db: Arc<DbPool>,
}

pub type SharedState = Arc<AppState>;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RegisterBody {
    #[serde(rename = "chainId")]
    chain_id: u64,
    address: String,
    #[serde(rename = "rpcUrl")]
    rpc_url: Option<String>,
}

#[derive(Deserialize)]
pub struct RegisterNativeBody {
    #[serde(rename = "chainId")]
    chain_id: u64,
    #[serde(rename = "rpcUrl")]
    rpc_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /healthz
async fn healthz(State(state): State<SharedState>) -> Json<Value> {
    let count = state.registry.len().await;
    Json(json!({ "ok": true, "count": count }))
}

/// GET /mcp — list all registered MCPs with metadata (no tool details).
/// Reads from DB so the list is accurate even before any MCP is built in memory.
async fn list_mcp(State(state): State<SharedState>) -> Response {
    let rows = match state.db.list_contracts_meta().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[list_mcp] db error: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "db error" })),
            )
                .into_response();
        }
    };

    let items: Vec<Value> = rows
        .into_iter()
        .map(|row: ContractMetaRow| {
            let name = if row.address == "native" {
                native_entry_name(row.chain_id)
            } else {
                entry_name(row.chain_id, &row.address)
            };
            json!({
                "name": name,
                "chainId": row.chain_id,
                "address": row.address,
                "implementation": row.implementation,
                "contractName": row.contract_name,
                "url": format!("/interface/{name}/mcp"),
            })
        })
        .collect();

    Json(json!(items)).into_response()
}

/// POST /register
/// Body: `{ chainId, address, rpcUrl? }`
///
/// Validates input, fetches ABI from Sourcify (once ever), persists to DB,
/// builds the MCP in memory, and returns the entry metadata.
async fn register(State(state): State<SharedState>, Json(body): Json<RegisterBody>) -> Response {
    let address = body.address.trim().to_string();

    // Mirrors ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
    if !is_valid_address(&address) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "address must be 0x-prefixed 20-byte hex" })),
        )
            .into_response();
    }

    // if (rpcUrl != null && (typeof rpcUrl !== "string" || rpcUrl.length === 0))
    if body.rpc_url.as_deref().is_some_and(|u| u.is_empty()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "rpcUrl must be a non-empty string" })),
        )
            .into_response();
    }

    let chain_id = body.chain_id;
    let name = entry_name(chain_id, &address);

    // If already in the registry, return immediately.
    if let Some(entry) = state.registry.get(&name).await {
        return Json(entry_response(&name, &entry)).into_response();
    }

    // Check DB for existing row — skip Sourcify if already registered.
    let existing = match state.db.load_contract(chain_id, &address).await {
        Ok(row) => row,
        Err(e) => {
            eprintln!("[register] db error: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "db error" })),
            )
                .into_response();
        }
    };

    let (abi_json, contract_name, implementation, rpc_url) = if let Some(row) = existing {
        (
            row.abi,
            row.contract_name,
            row.implementation,
            row.rpc_url.or(body.rpc_url),
        )
    } else {
        // Fetch from Sourcify and persist.
        let sourcify = match fetch_contract(chain_id, &address).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[register] sourcify error: {e:#}");
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("sourcify error: {e}") })),
                )
                    .into_response();
            }
        };

        let abi_json = match serde_json::to_value(&sourcify.abi) {
            Ok(v) => v,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
        };

        if let Err(e) = state
            .db
            .upsert_contract(
                chain_id,
                &address,
                sourcify.implementation.as_deref(),
                body.rpc_url.as_deref(),
                &abi_json,
                &sourcify.contract_name,
            )
            .await
        {
            eprintln!("[register] upsert error: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "db error" })),
            )
                .into_response();
        }

        (
            abi_json,
            sourcify.contract_name,
            sourcify.implementation,
            body.rpc_url,
        )
    };

    // Build and cache the MCP entry.
    let entry = match build_entry(
        chain_id,
        &address,
        abi_json,
        contract_name,
        implementation,
        rpc_url,
    ) {
        Ok(e) => e,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    state.registry.set(name.clone(), Arc::clone(&entry)).await;
    Json(entry_response(&name, &entry)).into_response()
}

/// POST /register-native
/// Body: `{ chainId, rpcUrl? }`
///
/// Registers a native-token MCP for a chain (no contract ABI needed).
/// Persists to DB and builds the in-memory entry.
async fn register_native(
    State(state): State<SharedState>,
    Json(body): Json<RegisterNativeBody>,
) -> Response {
    if body.rpc_url.as_deref().is_some_and(|u| u.is_empty()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "rpcUrl must be a non-empty string" })),
        )
            .into_response();
    }

    let chain_id = body.chain_id;
    let name = native_entry_name(chain_id);

    if let Some(entry) = state.registry.get(&name).await {
        return Json(entry_response(&name, &entry)).into_response();
    }

    let info = chain_info(chain_id);

    if let Err(e) = state
        .db
        .upsert_native_chain(chain_id, info.symbol, body.rpc_url.as_deref())
        .await
    {
        eprintln!("[register-native] db error: {e:#}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "db error" })),
        )
            .into_response();
    }

    let entry = build_native_entry(chain_id, body.rpc_url);
    state.registry.set(name.clone(), Arc::clone(&entry)).await;
    Json(entry_response(&name, &entry)).into_response()
}

/// POST /interface/:name/mcp
/// Requires `Authorization: Bearer <token>`.
///
/// Authenticates the request, lazy-loads the MCP from DB on cache miss,
/// and dispatches the MCP JSON-RPC body through EvmMcpServer::dispatch.
async fn handle_mcp(
    State(state): State<SharedState>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Auth — mirrors requireBearer from auth.mjs.
    let agent_id = match require_bearer(&headers, &state.db).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    // Registry lookup with lazy-load fallback.
    let entry = match get_or_load(&state, &name).await {
        Ok(Some(e)) => e,
        Ok(_none) => {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
        }
        Err(e) => {
            eprintln!("[mcp] load error: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "load error" })),
            )
                .into_response();
        }
    };

    entry.touch().await;

    // Build provider.
    let rpc_url = match &entry.rpc_url {
        Some(u) => u.clone(),
        _none => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "no rpc_url configured for this contract" })),
            )
                .into_response();
        }
    };

    let url = match rpc_url.parse() {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("invalid rpc_url: {e}") })),
            )
                .into_response();
        }
    };

    // Parse request body as JSON-RPC.
    let body_json: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid JSON: {e}") })),
            )
                .into_response();
        }
    };

    let provider = ProviderBuilder::new().connect_http(url);

    let result = if entry.is_native {
        NativeMcpServer::new(
            entry.chain_id,
            rpc_url,
            Arc::new(provider),
            Some(agent_id),
            Some(Arc::clone(&state.db)),
        )
        .dispatch(body_json)
        .await
    } else {
        EvmMcpServer::new(
            Arc::clone(&entry.abi),
            Arc::clone(&entry.tools),
            entry.address,
            entry.chain_id,
            rpc_url,
            Arc::new(provider),
            Some(agent_id),
            Some(Arc::clone(&state.db)),
        )
        .dispatch(body_json)
        .await
    };

    // Notifications: dispatch returns Null — send 202 No Content.
    if result.is_null() {
        return StatusCode::ACCEPTED.into_response();
    }

    Json(result).into_response()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Registry key for EVM contract MCPs: "{chain_id}_{address}".
pub fn entry_name(chain_id: u64, address: &str) -> String {
    format!("{chain_id}_{address}")
}

/// Registry key for native-token MCPs — mirrors entryName in server.mjs.
pub fn native_entry_name(chain_id: u64) -> String {
    format!("native_token_chain_id_{chain_id}")
}

/// Build an Arc<McpEntry> from raw DB data (EVM contract).
pub fn build_entry(
    chain_id: u64,
    address: &str,
    abi_json: Value,
    contract_name: String,
    implementation: Option<String>,
    rpc_url: Option<String>,
) -> anyhow::Result<Arc<McpEntry>> {
    let abi: JsonAbi = serde_json::from_value(abi_json).context("failed to parse ABI")?;
    let abi = Arc::new(abi);
    let tools = Arc::new(build_tools(&abi));
    let tool_count = tools.len();
    let addr: Address = address.parse().context("invalid address")?;

    let meta = McpMeta {
        chain_id,
        address: address.to_string(),
        implementation,
        contract_name,
        tool_count,
    };

    Ok(McpEntry::new(meta, abi, tools, addr, rpc_url, chain_id))
}

/// Build an Arc<McpEntry> for a native-token chain.
pub fn build_native_entry(chain_id: u64, rpc_url: Option<String>) -> Arc<McpEntry> {
    let info = chain_info(chain_id);
    let tools = Arc::new(build_native_tools(info.symbol));
    let meta = McpMeta {
        chain_id,
        address: "native".to_string(),
        implementation: None,
        contract_name: info.symbol.to_string(),
        tool_count: tools.len(),
    };
    McpEntry::new_native(meta, tools, rpc_url, chain_id)
}

/// Lazy-load helper: returns the registry entry, loading from DB on cache miss.
async fn get_or_load(state: &AppState, name: &str) -> anyhow::Result<Option<Arc<McpEntry>>> {
    if let Some(entry) = state.registry.get(name).await {
        return Ok(Some(entry));
    }

    // Native entry: "native_token_chain_id_{chain_id}"
    if let Some(chain_id_str) = name.strip_prefix("native_token_chain_id_") {
        let chain_id: u64 = chain_id_str
            .parse()
            .context("invalid chain_id in native name")?;

        let Some(row) = state.db.load_native_chain(chain_id).await? else {
            return Ok(None);
        };

        let entry = build_native_entry(chain_id, row.rpc_url);
        state
            .registry
            .set(name.to_string(), Arc::clone(&entry))
            .await;
        return Ok(Some(entry));
    }

    // EVM contract entry: "{chain_id}_{address}"
    let (chain_id, address) = match name.split_once('_') {
        Some((c, a)) => (
            c.parse::<u64>().context("invalid chain_id in name")?,
            a.to_string(),
        ),
        _none => anyhow::bail!("unrecognised name format: {name}"),
    };

    let Some(row) = state.db.load_contract(chain_id, &address).await? else {
        return Ok(None);
    };

    let entry = build_entry(
        chain_id,
        &address,
        row.abi,
        row.contract_name,
        row.implementation,
        row.rpc_url,
    )?;

    state
        .registry
        .set(name.to_string(), Arc::clone(&entry))
        .await;
    Ok(Some(entry))
}

/// Shape of the response returned by POST /register.
/// Response shape for POST /register — mirrors res.json({...}) in server.mjs.
fn entry_response(name: &str, entry: &McpEntry) -> Value {
    json!({
        "name": name,
        "chainId": entry.chain_id,
        "address": entry.meta.address,
        "implementation": entry.meta.implementation,
        "rpcUrl": entry.rpc_url,
        "contractName": entry.meta.contract_name,
        "url": format!("/interface/{name}/mcp"),
    })
}

/// Mirrors ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/ from server.mjs.
fn is_valid_address(address: &str) -> bool {
    address.len() == 42
        && address.starts_with("0x")
        && address[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Construct a new empty registry. Convenience for main.rs.
pub fn new_registry() -> Registry {
    Registry::new()
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp", get(list_mcp))
        .route("/register", post(register))
        .route("/register-native", post(register_native))
        .route("/interface/:name/mcp", post(handle_mcp))
        .layer(CorsLayer::permissive())
        .with_state(state)
}
