use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use sqlx::{Row, postgres::PgPoolOptions};
use tokio::sync::RwLock;

use crate::vault::sign_transaction::oneclaw_bearer_token;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/// Resolved vault binding for an agent. Mirrors the return type of
/// resolveVaultForAgent() in vault-resolve.js.
#[derive(Clone)]
pub enum VaultInfo {
    Orbitport {
        vault_id: String,
        kms_signing_key_id: String,
        /// EVM address of the signing key (checksummed).
        address: String,
    },
    Oneclaw {
        vault_id: String,
        /// Literal secret path inside the vault (no globs).
        signing_key_path: String,
    },
}

/// Row returned by `load_contract`.
pub struct ContractRow {
    pub chain_id: u64,
    pub address: String,
    pub abi: Value,
    pub contract_name: String,
    pub implementation: Option<String>,
    pub rpc_url: Option<String>,
}

/// Lightweight row returned by `list_contracts_meta` — no ABI.
pub struct ContractMetaRow {
    pub chain_id: u64,
    pub address: String,
    pub contract_name: String,
    pub implementation: Option<String>,
    pub rpc_url: Option<String>,
}

/// Row in the `networks` table — a chainId-indexed RPC directory, independent of the
/// contract-registration flow. Lets chain-agnostic MCPs (e.g. uniswap_mcp) resolve an
/// rpc_url from just a chainId instead of requiring the caller to pass one every time.
pub struct NetworkRow {
    pub chain_id: u64,
    pub name: String,
    pub rpc_url: String,
    pub native_token: String,
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

pub struct DbPool {
    pool: sqlx::PgPool,
    /// Process-scoped vault cache — agent_id → VaultInfo.
    /// Mirrors the `cache` Map in vault-resolve.js.
    vault_cache: RwLock<HashMap<String, VaultInfo>>,
}

impl DbPool {
    /// Connect to Postgres using a connection string (DATABASE_URL).
    /// Uses up to 10 connections. TLS is negotiated when the server offers it
    /// (sslmode=prefer); set sslmode=require in the URL to enforce it.
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(url)
            .await
            .context("postgres connect failed")?;

        Ok(Self {
            pool,
            vault_cache: RwLock::new(HashMap::new()),
        })
    }

    /// Create all required tables if they don't already exist.
    /// Safe to call on every startup.
    pub async fn ensure_tables(&self) -> Result<()> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS registered_contracts (
                chain_id        INTEGER      NOT NULL,
                address         TEXT         NOT NULL,
                implementation  TEXT,
                rpc_url         TEXT,
                abi             JSONB        NOT NULL,
                contract_name   TEXT         NOT NULL,
                registered_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
                PRIMARY KEY (chain_id, address)
            )",
        )
        .execute(&self.pool)
        .await
        .context("ensure_tables failed")?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS networks (
                chain_id      INTEGER      PRIMARY KEY,
                name          TEXT         NOT NULL,
                rpc_url       TEXT         NOT NULL,
                native_token  TEXT         NOT NULL,
                registered_at TIMESTAMPTZ  NOT NULL DEFAULT now()
            )",
        )
        .execute(&self.pool)
        .await
        .context("ensure_tables failed (networks)")?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Network directory — chainId -> { name, rpc_url, native_token }
// ---------------------------------------------------------------------------

impl DbPool {
    /// Upsert a network's RPC/name/native-token config, keyed by chain_id.
    pub async fn upsert_network(
        &self,
        chain_id: u64,
        name: &str,
        rpc_url: &str,
        native_token: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO networks (chain_id, name, rpc_url, native_token) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (chain_id) DO UPDATE SET \
               name         = EXCLUDED.name, \
               rpc_url      = EXCLUDED.rpc_url, \
               native_token = EXCLUDED.native_token",
        )
        .bind(chain_id as i32)
        .bind(name)
        .bind(rpc_url)
        .bind(native_token)
        .execute(&self.pool)
        .await
        .context("upsert_network failed")?;

        Ok(())
    }

    /// Look up a network's config by chain_id.
    pub async fn get_network(&self, chain_id: u64) -> Result<Option<NetworkRow>> {
        let row = sqlx::query(
            "SELECT chain_id, name, rpc_url, native_token FROM networks WHERE chain_id = $1",
        )
        .bind(chain_id as i32)
        .fetch_optional(&self.pool)
        .await
        .context("get_network failed")?;

        let Some(row) = row else { return Ok(None) };

        Ok(Some(NetworkRow {
            chain_id: row.try_get::<i32, _>("chain_id")? as u64,
            name: row.try_get("name")?,
            rpc_url: row.try_get("rpc_url")?,
            native_token: row.try_get("native_token")?,
        }))
    }

    /// List all configured networks, ordered by chain_id.
    pub async fn list_networks(&self) -> Result<Vec<NetworkRow>> {
        let rows = sqlx::query(
            "SELECT chain_id, name, rpc_url, native_token FROM networks ORDER BY chain_id",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_networks failed")?;

        rows.into_iter()
            .map(|r| {
                Ok(NetworkRow {
                    chain_id: r.try_get::<i32, _>("chain_id")? as u64,
                    name: r.try_get("name")?,
                    rpc_url: r.try_get("rpc_url")?,
                    native_token: r.try_get("native_token")?,
                })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Native chain persistence
// ---------------------------------------------------------------------------

impl DbPool {
    /// Upsert a native-token chain entry.
    /// Uses address='native' as a sentinel in registered_contracts.
    pub async fn upsert_native_chain(
        &self,
        chain_id: u64,
        symbol: &str,
        rpc_url: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO registered_contracts \
               (chain_id, address, implementation, rpc_url, abi, contract_name) \
             VALUES ($1, 'native', NULL, $2, '[]', $3) \
             ON CONFLICT (chain_id, address) DO UPDATE SET \
               rpc_url       = EXCLUDED.rpc_url, \
               contract_name = EXCLUDED.contract_name",
        )
        .bind(chain_id as i32)
        .bind(rpc_url)
        .bind(symbol)
        .execute(&self.pool)
        .await
        .context("upsert_native_chain failed")?;

        Ok(())
    }

    /// Load a native-token chain entry by chain_id.
    pub async fn load_native_chain(&self, chain_id: u64) -> Result<Option<ContractRow>> {
        self.load_contract(chain_id, "native").await
    }
}

// ---------------------------------------------------------------------------
// Auth — auth.mjs
// ---------------------------------------------------------------------------

impl DbPool {
    /// Look up a Bearer token in `mcp_api_key` and return its `agent_id`.
    ///
    /// Does a timing-safe byte comparison against the stored token to prevent
    /// timing-oracle attacks
    pub async fn lookup_token(&self, token: &str) -> Result<Option<String>> {
        let row = sqlx::query(
            "SELECT agent_id, token \
               FROM mcp_api_key \
              WHERE token = $1 AND revoked_at IS NULL \
              LIMIT 1",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .context("mcp_api_key lookup failed")?;

        let Some(row) = row else { return Ok(None) };

        let db_token: String = row.try_get("token")?;
        let agent_id: String = row.try_get("agent_id")?;

        if constant_time_eq(db_token.as_bytes(), token.as_bytes()) {
            Ok(Some(agent_id))
        } else {
            Ok(None)
        }
    }
}

// ---------------------------------------------------------------------------
// Contract persistence — server.mjs / CLAUDE.md
// ---------------------------------------------------------------------------

impl DbPool {
    /// Upsert a registered contract. Called exactly once per (chain_id, address)
    /// at registration time — never reads from Sourcify again after this.
    pub async fn upsert_contract(
        &self,
        chain_id: u64,
        address: &str,
        implementation: Option<&str>,
        rpc_url: Option<&str>,
        abi: &Value,
        contract_name: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO registered_contracts \
               (chain_id, address, implementation, rpc_url, abi, contract_name) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (chain_id, address) DO UPDATE SET \
               implementation = EXCLUDED.implementation, \
               rpc_url        = EXCLUDED.rpc_url, \
               abi            = EXCLUDED.abi, \
               contract_name  = EXCLUDED.contract_name",
        )
        .bind(chain_id as i32)
        .bind(address)
        .bind(implementation)
        .bind(rpc_url)
        .bind(abi)
        .bind(contract_name)
        .execute(&self.pool)
        .await
        .context("upsert_contract failed")?;

        Ok(())
    }

    /// Load a persisted contract by (chain_id, address).
    /// Used for lazy-loading after an idle eviction (see CLAUDE.md registry design).
    pub async fn load_contract(&self, chain_id: u64, address: &str) -> Result<Option<ContractRow>> {
        let row = sqlx::query(
            "SELECT abi, contract_name, implementation, rpc_url \
               FROM registered_contracts \
              WHERE chain_id = $1 AND address = $2",
        )
        .bind(chain_id as i32)
        .bind(address)
        .fetch_optional(&self.pool)
        .await
        .context("load_contract failed")?;

        let Some(row) = row else { return Ok(None) };

        Ok(Some(ContractRow {
            chain_id,
            address: address.to_string(),
            abi: row.try_get("abi")?,
            contract_name: row.try_get("contract_name")?,
            implementation: row.try_get("implementation")?,
            rpc_url: row.try_get("rpc_url")?,
        }))
    }

    /// List all registered contracts from the database (no ABI — lightweight).
    /// Used by GET /mcp to enumerate available MCPs without loading their ABIs.
    pub async fn list_contracts_meta(&self) -> Result<Vec<ContractMetaRow>> {
        let rows = sqlx::query(
            "SELECT chain_id, address, contract_name, implementation, rpc_url \
               FROM registered_contracts",
        )
        .fetch_all(&self.pool)
        .await
        .context("list_contracts_meta failed")?;

        rows.into_iter()
            .map(|r| {
                Ok(ContractMetaRow {
                    chain_id: r.try_get::<i32, _>("chain_id")? as u64,
                    address: r.try_get("address")?,
                    contract_name: r.try_get("contract_name")?,
                    implementation: r.try_get("implementation")?,
                    rpc_url: r.try_get("rpc_url")?,
                })
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Vault resolution — vault-resolve.js
// ---------------------------------------------------------------------------

impl DbPool {
    /// Orbitport branch: find a live grant on an Orbitport vault for the agent.
    async fn find_orbitport_grant(&self, agent_id: &str) -> Result<Option<OrbitportGrantRow>> {
        let row = sqlx::query(
            "SELECT v.vault_id, v.kms_signing_key_id, v.address \
               FROM orbitport_grant g \
               JOIN orbitport_vault v ON v.vault_id = g.vault_id \
              WHERE g.agent_id = $1 \
                AND (g.expires_at IS NULL OR g.expires_at > now()) \
              ORDER BY g.created_at ASC \
              LIMIT 1",
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await
        .context("orbitport_grant lookup failed")?;

        let Some(row) = row else { return Ok(None) };

        Ok(Some(OrbitportGrantRow {
            vault_id: row.try_get("vault_id")?,
            kms_signing_key_id: row.try_get("kms_signing_key_id")?,
            address: row.try_get("address")?,
        }))
    }

    /// 1Claw branch, step 1: resolve the user that owns the agent.
    async fn find_user_for_agent(&self, agent_id: &str) -> Result<Option<String>> {
        let row = sqlx::query("SELECT user_id FROM agent_ownership WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await
            .context("agent_ownership lookup failed")?;

        Ok(row.map(|r| r.try_get("user_id")).transpose()?)
    }

    /// 1Claw branch, step 2: find the user's 1Claw vault.
    async fn find_oneclaw_vault(&self, user_id: &str) -> Result<Option<String>> {
        let row = sqlx::query(
            "SELECT vault_id FROM vault_ownership \
              WHERE user_id = $1 AND provider = 'oneclaw' \
              ORDER BY created_at ASC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .context("vault_ownership lookup failed")?;

        Ok(row.map(|r| r.try_get("vault_id")).transpose()?)
    }

    /// Resolve the vault binding for an agent, with a process-level cache.
    ///
    /// Mirrors `resolveVaultForAgent()` in vault-resolve.js:
    ///   1. Check cache.
    ///   2. Try Orbitport — `orbitport_grant JOIN orbitport_vault`.
    ///   3. Fall back to 1Claw — `agent_ownership` → `vault_ownership` →
    ///      1Claw `listGrants` HTTP call (the HTTP call lives in src/vault/oneclaw.rs,
    ///      which is not yet implemented — this method returns an error at that point).
    pub async fn resolve_vault(&self, agent_id: &str) -> Result<VaultInfo> {
        // Fast path: cache hit.
        {
            let cache = self.vault_cache.read().await;
            if let Some(info) = cache.get(agent_id) {
                return Ok(info.clone());
            }
        }

        // Orbitport branch.
        if let Some(row) = self.find_orbitport_grant(agent_id).await? {
            let info = VaultInfo::Orbitport {
                vault_id: row.vault_id,
                kms_signing_key_id: row.kms_signing_key_id,
                address: row.address,
            };
            self.vault_cache
                .write()
                .await
                .insert(agent_id.to_string(), info.clone());
            return Ok(info);
        }

        // 1Claw branch — DB queries.
        let user_id = self
            .find_user_for_agent(agent_id)
            .await?
            .with_context(|| format!("no agent_ownership row for agent_id={agent_id}"))?;

        let vault_id = self.find_oneclaw_vault(&user_id).await?.with_context(|| {
            format!(
                "agent {agent_id} has no Orbitport grant and the owning user has no 1Claw vault"
            )
        })?;

        // Call 1Claw: GET /v1/vaults/{vault_id}/policies → find the agent grant.
        // Mirrors: client.access.listGrants(vaultId) in vault-resolve.js.
        let signing_key_path = oneclaw_list_grants_signing_path(&vault_id).await?;

        let info = VaultInfo::Oneclaw {
            vault_id,
            signing_key_path,
        };
        self.vault_cache
            .write()
            .await
            .insert(agent_id.to_string(), info.clone());

        Ok(info)
    }

    /// Evict one or all entries from the vault cache.
    /// Call this when an upstream vault/KMS call returns an auth error.
    ///
    /// Mirrors `clearVaultCache()` in vault-resolve.js.
    pub async fn clear_vault_cache(&self, agent_id: Option<&str>) {
        let mut cache = self.vault_cache.write().await;
        match agent_id {
            Some(id) => {
                cache.remove(id);
            }
            _none => cache.clear(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool call logging — log-tool-call.mjs
// ---------------------------------------------------------------------------

impl DbPool {
    /// Log one tool call. Inserts into `tool_call_log` (joining agent_ownership
    /// for user_id) and upserts into `user_mcp_binding`.
    ///
    /// Mirrors `logToolCall()` in log-tool-call.mjs. Errors are logged but
    /// never surfaced to the caller (same behavior as the JS version).
    pub async fn log_tool_call(
        &self,
        agent_id: &str,
        mcp_name: &str,
        contract_name: Option<&str>,
        tool_name: &str,
        args: Option<&Value>,
        status: &str,
        result_summary: Option<&str>,
        error_message: Option<&str>,
    ) {
        if let Err(e) = self
            .log_tool_call_inner(
                agent_id,
                mcp_name,
                contract_name,
                tool_name,
                args,
                status,
                result_summary,
                error_message,
            )
            .await
        {
            eprintln!("[metrics] logToolCall failed: {e:#}");
        }
    }

    async fn log_tool_call_inner(
        &self,
        agent_id: &str,
        mcp_name: &str,
        contract_name: Option<&str>,
        tool_name: &str,
        args: Option<&Value>,
        status: &str,
        result_summary: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<()> {
        const ARGS_CAP: usize = 4096;
        const STR_CAP: usize = 500;

        // Truncate args JSON if over ARGS_CAP bytes (mirrors safeArgs in JS).
        let args_stored: Option<Value> = args.map(|a| {
            let json = serde_json::to_string(a).unwrap_or_default();
            if json.len() > ARGS_CAP {
                serde_json::json!({ "_truncated": true, "preview": &json[..ARGS_CAP] })
            } else {
                a.clone()
            }
        });

        let result_summary = result_summary.map(|s| truncate_chars(s, STR_CAP));
        let error_message = error_message.map(|s| truncate_chars(s, STR_CAP));

        eprintln!("[metrics] logging {tool_name} for agent {agent_id} on {mcp_name}");

        // Insert the tool call log row. user_id is resolved inline via agent_ownership.
        sqlx::query(
            "INSERT INTO tool_call_log \
               (agent_id, user_id, mcp_name, contract_name, tool_name, args, \
                status, result_summary, error_message) \
             SELECT $1, ao.user_id, $2, $3, $4, $5, $6, $7, $8 \
               FROM agent_ownership ao WHERE ao.agent_id = $1",
        )
        .bind(agent_id)
        .bind(mcp_name)
        .bind(contract_name)
        .bind(tool_name)
        .bind(args_stored.as_ref())
        .bind(status)
        .bind(result_summary.as_deref())
        .bind(error_message.as_deref())
        .execute(&self.pool)
        .await
        .context("tool_call_log insert failed")?;

        // Upsert the MCP binding so the UI knows which MCPs an agent has used.
        sqlx::query(
            "INSERT INTO user_mcp_binding (user_id, mcp_name) \
             SELECT ao.user_id, $2 FROM agent_ownership ao WHERE ao.agent_id = $1 \
             ON CONFLICT (user_id, mcp_name) DO NOTHING",
        )
        .bind(agent_id)
        .bind(mcp_name)
        .execute(&self.pool)
        .await
        .context("user_mcp_binding upsert failed")?;

        eprintln!("[metrics] logged and bound {mcp_name}");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

struct OrbitportGrantRow {
    vault_id: String,
    kms_signing_key_id: String,
    address: String,
}

/// Fetch the signing key path for this vault from the 1Claw policies API.
///
/// Calls GET /v1/vaults/{vault_id}/policies, finds the policy with
/// `principal_type == "agent"`, and returns its `secret_path_pattern`.
/// Validates that the path is literal (no glob characters).
///
/// Mirrors the `client.access.listGrants(vaultId)` call in vault-resolve.js.
async fn oneclaw_list_grants_signing_path(vault_id: &str) -> Result<String> {
    let api_key = std::env::var("ONECLAW_API_KEY").context("ONECLAW_API_KEY not set")?;
    let base_url =
        std::env::var("ONECLAW_BASE_URL").unwrap_or_else(|_| "https://api.1claw.xyz".to_string());

    let bearer = oneclaw_bearer_token(&base_url, &api_key)
        .await
        .context("1Claw auth failed during vault resolution")?;

    let resp: Value = reqwest::Client::new()
        .get(format!("{base_url}/v1/vaults/{vault_id}/policies"))
        .bearer_auth(&bearer)
        .send()
        .await
        .context("1Claw listGrants request failed")?
        .error_for_status()
        .context("1Claw listGrants returned error status")?
        .json()
        .await
        .context("failed to parse 1Claw listGrants response")?;

    let policies = resp["policies"]
        .as_array()
        .with_context(|| format!("no 'policies' array in 1Claw response for vault {vault_id}"))?;

    // Find the first policy granted to an agent principal.
    let agent_grant = policies
        .iter()
        .find(|p| p["principal_type"].as_str() == Some("agent"))
        .with_context(|| {
            format!("1Claw vault {vault_id} has no agent grant — cannot resolve a signing wallet")
        })?;

    let path = agent_grant["secret_path_pattern"]
        .as_str()
        .with_context(|| format!("agent grant on vault {vault_id} has no secret_path_pattern"))?;

    // Reject glob patterns — we need a literal path to fetch a specific key.
    if path.contains('*') || path.contains('?') || path.contains('[') {
        bail!(
            "1Claw agent grant on vault {vault_id} has non-literal path \"{path}\" — \
             cannot pick a unique signing wallet"
        );
    }

    Ok(path.to_string())
}

/// Timing-safe byte comparison.
/// Mirrors `timingSafeEqual` from Node.js `crypto` used in auth.mjs.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Truncate a string to at most `max_chars` Unicode scalar values.
fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        _none => s,
    }
}
