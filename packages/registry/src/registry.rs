use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use alloy::{json_abi::JsonAbi, primitives::Address};
use rmcp::model::Tool;
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const EVICTION_INTERVAL: Duration = Duration::from_secs(60);

/// Metadata about a registered MCP, returned by GET /mcp.
#[derive(Clone, Serialize)]
pub struct McpMeta {
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    pub address: String,
    pub implementation: Option<String>,
    #[serde(rename = "contractName")]
    pub contract_name: String,
    #[serde(rename = "toolCount")]
    pub tool_count: usize,
}

/// One live entry in the in-memory registry.
pub struct McpEntry {
    pub meta: McpMeta,
    /// True for native-token MCPs; false for EVM contract MCPs.
    pub is_native: bool,
    pub abi: Arc<JsonAbi>,
    pub tools: Arc<Vec<Tool>>,
    pub address: Address,
    pub rpc_url: Option<String>,
    pub chain_id: u64,
    last_used: Mutex<Instant>,
}

impl McpEntry {
    pub fn new(
        meta: McpMeta,
        abi: Arc<JsonAbi>,
        tools: Arc<Vec<Tool>>,
        address: Address,
        rpc_url: Option<String>,
        chain_id: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            meta,
            is_native: false,
            abi,
            tools,
            address,
            rpc_url,
            chain_id,
            last_used: Mutex::new(Instant::now()),
        })
    }

    /// Construct a native-token entry (no ABI, no contract address).
    pub fn new_native(
        meta: McpMeta,
        tools: Arc<Vec<Tool>>,
        rpc_url: Option<String>,
        chain_id: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            meta,
            is_native: true,
            abi: Arc::new(JsonAbi::default()),
            tools,
            address: Address::ZERO,
            rpc_url,
            chain_id,
            last_used: Mutex::new(Instant::now()),
        })
    }

    pub async fn touch(&self) {
        *self.last_used.lock().await = Instant::now();
    }

    pub async fn is_idle(&self) -> bool {
        self.last_used.lock().await.elapsed() > IDLE_TIMEOUT
    }
}

/// The in-memory MCP registry with lazy-loading and idle eviction.
#[derive(Clone)]
pub struct Registry {
    inner: Arc<RwLock<HashMap<String, Arc<McpEntry>>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn get(&self, name: &str) -> Option<Arc<McpEntry>> {
        self.inner.read().await.get(name).cloned()
    }

    pub async fn set(&self, name: String, entry: Arc<McpEntry>) {
        self.inner.write().await.insert(name, entry);
    }

    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }

    pub async fn list_meta(&self) -> Vec<(String, McpMeta)> {
        self.inner
            .read()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.meta.clone()))
            .collect()
    }

    /// Spawn a background tokio task that evicts entries idle > 30 min.
    /// Call once at startup.
    pub fn spawn_eviction_task(&self) {
        let registry = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(EVICTION_INTERVAL);
            loop {
                interval.tick().await;
                registry.evict_idle().await;
            }
        });
    }

    async fn evict_idle(&self) {
        let mut to_evict = Vec::new();
        {
            let map = self.inner.read().await;
            for (name, entry) in map.iter() {
                if entry.is_idle().await {
                    to_evict.push(name.clone());
                }
            }
        }
        if !to_evict.is_empty() {
            let mut map = self.inner.write().await;
            for name in &to_evict {
                map.remove(name);
            }
            eprintln!("[registry] evicted {} idle entries: {:?}", to_evict.len(), to_evict);
        }
    }
}
