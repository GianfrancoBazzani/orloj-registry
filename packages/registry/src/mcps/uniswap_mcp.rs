// Chain-agnostic MCP wrapping the Uniswap Trading API
// (https://trade-api.gateway.uniswap.org/v1 — see developers.uniswap.org/docs/trading/swapping-api).
//
// Unlike EvmMcpServer/NativeMcpServer, this server is not bound to a single chain at
// construction time: `chainId` is a required tool argument on every call so it's never
// ambiguous which network is targeted. `swap` needs an rpc_url to sign/broadcast — always
// resolved from the `networks` table by chainId (db::DbPool::get_network), never accepted
// as a tool argument. `supported_networks` lists what's registered there.
//
// `quote` is a read-only call to Uniswap's /quote endpoint, priced for the authenticated
// agent's own wallet (resolved via the vault, same as `swap` — no raw keys, no signing).
//
// `swap` resolves the authenticated agent's own wallet address (via the vault, no raw keys) and
// executes the full flow with no manual approval step required by the caller:
//   1. Get a quote for the resolved swapper (defaults slippageTolerance to a conservative 0.5%
//      if the caller doesn't specify one — this is what actually bounds the min output Uniswap's
//      router will accept on-chain, so it's the real fund-protection lever here).
//   2. POST /check_approval for the resolved input amount. If the ERC-20 token doesn't yet trust
//      Permit2 on-chain, sign + broadcast the returned approval tx and wait for it to confirm
//      before moving on (native-currency input skips this layer entirely).
//   3. If an approval tx had to be mined, re-fetch the quote — the wait can make the first one
//      stale (quote pricing / Permit2 nonce / sigDeadline).
//   4. If the (possibly refreshed) quote carries `permitData`, that's Permit2's per-swap
//      EIP-712 message (the canonical PermitSingle struct — same shape on every chain). Its
//      signing hash is computed by hand from `alloy::primitives::keccak256` (see permit2_digest
//      below) and signed via sign_permit_digest() — Orbitport KMS or a locally-fetched 1Claw
//      key, mirroring (but not touching) vault::sign_transaction's own two backends. Kept local
//      to this file since Permit2 signing is this MCP's concern, not the shared tx-signing path.
//   5. POST /swap with the quote (+ signature/permitData if step 4 ran), then sign + broadcast
//      the returned transaction through the same vault-signing path as EvmMcpServer write calls.
//
// A wrong Permit2 digest just makes Permit2's own signature check revert on-chain — it can't
// authorize a transfer it wasn't actually signed for, so a bug here fails closed rather than
// risking funds.
//
// Env vars:
//   UNISWAP_API_KEY  – Uniswap Trading API key (required)
//   UNISWAP_API_URL  – base URL (default: https://trade-api.gateway.uniswap.org/v1)
//   ONECLAW_API_KEY / ONECLAW_BASE_URL                                   – needed only if the
//     agent's vault is 1Claw-backed (ONECLAW_BASE_URL has a default; ONECLAW_API_KEY doesn't)
//   ORBITPORT_CLIENT_ID / ORBITPORT_CLIENT_SECRET / ORBITPORT_API_URL    – needed only if the
//     agent's vault is Orbitport-backed (via orbitport_access_token() in vault::sign_transaction;
//     CLIENT_ID/CLIENT_SECRET have no defaults, API_URL does)

use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::keccak256;
use alloy::{
    primitives::{Address, B256, Bytes, U256},
    providers::{Provider, ProviderBuilder},
    signers::{Signer, local::PrivateKeySigner},
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value, json};

use crate::{
    db::{DbPool, NetworkRow, VaultInfo},
    vault::sign_transaction::{
        SignTransactionParams, oneclaw_bearer_token, orbitport_access_token,
        resolve_agent_address, sign_transaction,
    },
};

/// Applied to `swap` when the caller doesn't supply `slippageTolerance`. Chosen deliberately
/// rather than leaving it to whatever Uniswap's own undocumented default is, since this is the
/// value that bounds acceptable price movement for a fund-moving call.
const DEFAULT_SLIPPAGE_TOLERANCE_PCT: f64 = 0.5;

/// Sentinel used by the Uniswap Trading API for a chain's native currency (ETH, MATIC, ...).
/// Native input never needs an ERC-20 → Permit2 allowance, so `swap` skips /check_approval for it.
const NATIVE_TOKEN_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

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
        build_uniswap_tools(&networks)
    }
}

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

/// `chainId` property schema. `type: "string"` (not "integer") is deliberate: MCP Inspector
/// (and other client UIs) only render `enum` as a dropdown for string-typed properties — the
/// `type` property (EXACT_INPUT/EXACT_OUTPUT) already relies on the same thing. Values still
/// parse as chain IDs on our side regardless of whether a client sends a JSON string or number
/// (see parse_chain_id_arg) — our own arg parsing doesn't enforce the enum either way, so a
/// chainId outside the list still works if a client lets you send one.
fn build_chain_id_prop(networks: &[NetworkRow]) -> Value {
    if networks.is_empty() {
        return json!({
            "type": "string",
            "description": "EVM chain ID (as a string, e.g. \"1\") for both the input and output token. Required on every call so the swap is never ambiguous about which network it targets."
        });
    }

    let mut sorted: Vec<&NetworkRow> = networks.iter().collect();
    sorted.sort_by_key(|n| n.chain_id);

    let registered = sorted
        .iter()
        .map(|n| format!("{} = {}", n.chain_id, n.name))
        .collect::<Vec<_>>()
        .join(", ");

    json!({
        "type": "string",
        "enum": sorted.iter().map(|n| n.chain_id.to_string()).collect::<Vec<_>>(),
        "description": format!(
            "EVM chain ID (as a string) for both the input and output token. Required on every \
             call so the swap is never ambiguous about which network it targets. Registered \
             networks — `swap` needs its chainId to be one of these, since that's how it \
             resolves an RPC endpoint: {registered} (call `supported_networks` for the live \
             list). `quote` isn't limited to these; any Uniswap-supported chainId works there \
             too, since it never touches an RPC."
        ),
    })
}

pub fn build_uniswap_tools(networks: &[NetworkRow]) -> Vec<Tool> {
    let chain_id_prop = build_chain_id_prop(networks);
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
        "Get a Uniswap price quote and route for a token pair on a given chain, priced for the authenticated agent's own wallet. Read-only — does not move funds.".to_string(),
        {
            let mut props = Map::new();
            props.insert("chainId".to_string(), chain_id_prop.clone());
            props.insert("tokenIn".to_string(), token_in_prop.clone());
            props.insert("tokenOut".to_string(), token_out_prop.clone());
            props.insert("amount".to_string(), amount_prop.clone());
            props.insert("type".to_string(), type_prop.clone());
            props.insert("slippageTolerance".to_string(), slippage_prop.clone());

            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(
                    ["chainId", "tokenIn", "tokenOut", "amount"]
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
        "Execute a Uniswap swap on behalf of the authenticated agent — fully automatic, no separate approval call needed. The RPC endpoint is resolved from `chainId` via the `networks` table (see supported_networks), so only registered chains work here. Resolves the agent's own wallet, gets a quote, transparently handles both Permit2 layers if required (on-chain ERC-20→Permit2 approval, signed off-chain via the vault if the token needs it — waits for it to confirm; then the per-swap Permit2 EIP-712 signature, also signed via the vault), then signs and broadcasts the swap transaction.".to_string(),
        {
            let mut props = Map::new();
            props.insert("chainId".to_string(), chain_id_prop);
            props.insert("tokenIn".to_string(), token_in_prop);
            props.insert("tokenOut".to_string(), token_out_prop);
            props.insert("amount".to_string(), amount_prop);
            props.insert("type".to_string(), type_prop);
            props.insert(
                "slippageTolerance".to_string(),
                json!({
                    "type": "number",
                    "description": "Maximum acceptable slippage in percent (e.g. 0.5 for 0.5%). Defaults to 0.5% if omitted — this is what bounds the minimum output Uniswap's router will accept on-chain, protecting the swap from bad fills."
                }),
            );

            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(props));
            schema.insert(
                "required".to_string(),
                Value::Array(
                    ["chainId", "tokenIn", "tokenOut", "amount"]
                        .into_iter()
                        .map(|s| Value::String(s.to_string()))
                        .collect(),
                ),
            );
            schema
        },
    );

    let supported_networks = Tool::new(
        "supported_networks".to_string(),
        "List the chainIds this registry has a network config for (name + chainId). `swap` only works on these — its rpc_url is always resolved from this table, never passed as an argument.".to_string(),
        {
            let mut schema = Map::new();
            schema.insert("type".to_string(), Value::String("object".to_string()));
            schema.insert("properties".to_string(), Value::Object(Map::new()));
            schema
        },
    );

    vec![quote, swap, supported_networks]
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
        Some(hex) => U256::from_str_radix(hex, 16).context("invalid hex value in transaction"),
        _none => U256::from_str_radix(s, 10).context("invalid decimal value in transaction"),
    }
}

/// Reads `chainId` as either a JSON string (what the tool schema now advertises, so enum
/// dropdowns render in clients like MCP Inspector) or a JSON number (still accepted, in case
/// a client sends one despite the schema).
fn parse_chain_id_arg(args: &Map<String, Value>) -> Option<u64> {
    match args.get("chainId") {
        Some(Value::String(s)) => s.parse().ok(),
        Some(v) => v.as_u64(),
        _none => None,
    }
}

// ---------------------------------------------------------------------------
// Permit2 EIP-712 signing hash — hand-computed from alloy::primitives::keccak256.
//
// permitData.values is always Permit2's canonical PermitSingle struct (confirmed against
// Uniswap's OpenAPI spec at trade-api.gateway.uniswap.org/v1/api.json — same field names,
// same shape as the open-source Permit2 contract's AllowanceTransfer.PermitSingle):
//
//   struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }
//   struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }
//
// This is the one canonical Permit2 deployment (same address on every chain), so the struct
// shape is fixed — no need for a generic runtime EIP-712 type decoder. `domain` still comes
// straight from Uniswap's response rather than being hardcoded, since that's the authoritative
// per-chain value.
// ---------------------------------------------------------------------------

const PERMIT_DETAILS_TYPE: &str =
    "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)";
const PERMIT_SINGLE_TYPE: &str = "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)";

fn word_from_address(addr: Address) -> B256 {
    addr.into_word()
}

fn word_from_decimal_str(s: &str) -> Result<B256> {
    Ok(B256::from(parse_flexible_u256(s)?.to_be_bytes::<32>()))
}

/// EIP-712 domain separator, built only from whichever of {name, version, chainId,
/// verifyingContract} are present in `domain` — in that fixed canonical order, per spec.
/// Permit2's own domain only ever sets name/chainId/verifyingContract (no version, no salt),
/// but this doesn't hardcode that assumption beyond refusing an unsupported `salt` field.
fn eip712_domain_separator(domain: &Value) -> Result<B256> {
    anyhow::ensure!(
        domain.get("salt").is_none(),
        "unsupported EIP-712 domain field 'salt' in Permit2 permitData"
    );

    let name = domain.get("name").and_then(|v| v.as_str());
    let version = domain.get("version").and_then(|v| v.as_str());
    let chain_id = domain.get("chainId").and_then(|v| v.as_u64());
    let verifying_contract = domain.get("verifyingContract").and_then(|v| v.as_str());

    let mut type_fields = Vec::new();
    if name.is_some() {
        type_fields.push("string name");
    }
    if version.is_some() {
        type_fields.push("string version");
    }
    if chain_id.is_some() {
        type_fields.push("uint256 chainId");
    }
    if verifying_contract.is_some() {
        type_fields.push("address verifyingContract");
    }

    let type_hash = keccak256(format!("EIP712Domain({})", type_fields.join(",")).as_bytes());

    let mut words = vec![type_hash];
    if let Some(name) = name {
        words.push(keccak256(name.as_bytes()));
    }
    if let Some(version) = version {
        words.push(keccak256(version.as_bytes()));
    }
    if let Some(chain_id) = chain_id {
        let mut word = [0u8; 32];
        word[24..].copy_from_slice(&chain_id.to_be_bytes());
        words.push(B256::from(word));
    }
    if let Some(vc) = verifying_contract {
        let addr: Address = vc.parse().context("invalid domain.verifyingContract")?;
        words.push(word_from_address(addr));
    }

    let mut buf = Vec::with_capacity(32 * words.len());
    for w in &words {
        buf.extend_from_slice(w.as_slice());
    }
    Ok(keccak256(&buf))
}

/// Computes the EIP-712 signing hash for a Permit2 `permitData` object as returned by
/// Uniswap's /quote (`{ domain, types, values: { details: {...}, spender, sigDeadline } }`).
fn permit2_digest(permit_data: &Value) -> Result<B256> {
    let domain = permit_data
        .get("domain")
        .context("permitData missing 'domain'")?;
    let values = permit_data
        .get("values")
        .context("permitData missing 'values'")?;
    let details = values
        .get("details")
        .context("permitData.values missing 'details'")?;

    let domain_separator = eip712_domain_separator(domain)?;

    let token: Address = details
        .get("token")
        .and_then(|v| v.as_str())
        .context("permitData.values.details missing 'token'")?
        .parse()
        .context("invalid permitData.values.details.token")?;
    let amount = details
        .get("amount")
        .and_then(|v| v.as_str())
        .context("permitData.values.details missing 'amount'")?;
    let expiration = details
        .get("expiration")
        .and_then(|v| v.as_str())
        .context("permitData.values.details missing 'expiration'")?;
    let nonce = details
        .get("nonce")
        .and_then(|v| v.as_str())
        .context("permitData.values.details missing 'nonce'")?;
    let spender: Address = values
        .get("spender")
        .and_then(|v| v.as_str())
        .context("permitData.values missing 'spender'")?
        .parse()
        .context("invalid permitData.values.spender")?;
    let sig_deadline = values
        .get("sigDeadline")
        .and_then(|v| v.as_str())
        .context("permitData.values missing 'sigDeadline'")?;

    let mut details_buf = Vec::with_capacity(32 * 5);
    details_buf.extend_from_slice(keccak256(PERMIT_DETAILS_TYPE.as_bytes()).as_slice());
    details_buf.extend_from_slice(word_from_address(token).as_slice());
    details_buf.extend_from_slice(word_from_decimal_str(amount)?.as_slice());
    details_buf.extend_from_slice(word_from_decimal_str(expiration)?.as_slice());
    details_buf.extend_from_slice(word_from_decimal_str(nonce)?.as_slice());
    let details_struct_hash = keccak256(&details_buf);

    let mut single_buf = Vec::with_capacity(32 * 4);
    single_buf.extend_from_slice(keccak256(PERMIT_SINGLE_TYPE.as_bytes()).as_slice());
    single_buf.extend_from_slice(details_struct_hash.as_slice());
    single_buf.extend_from_slice(word_from_address(spender).as_slice());
    single_buf.extend_from_slice(word_from_decimal_str(sig_deadline)?.as_slice());
    let single_struct_hash = keccak256(&single_buf);

    let mut digest_buf = Vec::with_capacity(2 + 32 + 32);
    digest_buf.extend_from_slice(&[0x19, 0x01]);
    digest_buf.extend_from_slice(domain_separator.as_slice());
    digest_buf.extend_from_slice(single_struct_hash.as_slice());
    Ok(keccak256(&digest_buf))
}

// ---------------------------------------------------------------------------
// Permit2 digest signing — self-contained in this file. Reuses only the already-`pub` pieces
// of vault::sign_transaction (resolve_agent_address, sign_transaction, orbitport_access_token,
// oneclaw_bearer_token); the KMS digest call and 1Claw secret fetch are duplicated locally
// rather than exposing new surface area from the shared vault module.
// ---------------------------------------------------------------------------

/// Signs an arbitrary 32-byte digest (here: a Permit2 EIP-712 signing hash) with the agent's
/// vault. Returns the 65-byte ECDSA signature (r || s || v, v = 27/28) Permit2 expects.
async fn sign_permit_digest(db: &DbPool, agent_id: &str, digest: B256) -> Result<[u8; 65]> {
    let vault = db
        .resolve_vault(agent_id)
        .await
        .context("vault resolution failed")?;

    match vault {
        VaultInfo::Orbitport { kms_signing_key_id, .. } => {
            orbitport_sign_digest(&kms_signing_key_id, digest).await
        }

        VaultInfo::Oneclaw { vault_id, signing_key_path } => {
            let private_key = oneclaw_get_private_key(&vault_id, &signing_key_path).await?;
            let signer: PrivateKeySigner = private_key
                .parse()
                .context("invalid private key returned from 1Claw")?;

            let sig = signer
                .sign_hash(&digest)
                .await
                .context("local Permit2 digest signing failed")?;

            let mut out = [0u8; 65];
            out[0..32].copy_from_slice(&sig.r().to_be_bytes::<32>());
            out[32..64].copy_from_slice(&sig.s().to_be_bytes::<32>());
            out[64] = if sig.v() { 28 } else { 27 };
            Ok(out)
        }
    }
}

/// Calls Orbitport KMS (`kms.Sign`) to sign an arbitrary 32-byte digest. Returns the raw
/// 65-byte secp256k1 signature (r[32] || s[32] || v[1]), v normalised to 27/28.
///
/// Mirrors the digest-signing half of vault::sign_transaction's Orbitport path (KMSService
/// in the Orbitport SDK) — duplicated here rather than imported, per the constraint that
/// Permit2 signing stays local to this file.
async fn orbitport_sign_digest(kms_signing_key_id: &str, digest: B256) -> Result<[u8; 65]> {
    let token = orbitport_access_token().await?;

    let api_url = std::env::var("ORBITPORT_API_URL")
        .unwrap_or_else(|_| "https://op.spacecomputer.io".to_string());

    let resp: Value = reqwest::Client::new()
        .post(format!("{api_url}/api/v1/rpc"))
        .bearer_auth(&token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "kms.Sign",
            "params": {
                "KeyId": kms_signing_key_id,
                "Message": B64.encode(digest.as_slice()),
                "SigningAlgorithm": "ETHEREUM_SECP256K1",
                "MessageType": "DIGEST",
            },
        }))
        .send()
        .await
        .context("Orbitport kms.Sign request failed")?
        .error_for_status()
        .context("Orbitport kms.Sign returned HTTP error")?
        .json()
        .await
        .context("failed to parse Orbitport kms.Sign response")?;

    if let Some(err) = resp.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        anyhow::bail!("Orbitport kms.Sign JSON-RPC error {code}: {msg}");
    }

    let raw_sig = resp["result"]["Signature"]
        .as_str()
        .context("missing Signature in Orbitport kms.Sign result")?;

    let sig_bytes = decode_orbitport_signature(raw_sig)?;
    anyhow::ensure!(
        sig_bytes.len() == 65,
        "Orbitport signature length is {} (want 65)",
        sig_bytes.len()
    );

    let v_raw = sig_bytes[64];
    let v = if v_raw < 27 { v_raw + 27 } else { v_raw };

    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig_bytes[..64]);
    out[64] = v;
    Ok(out)
}

/// Mirrors decodeSignature() in vault-providers/orbitport.js: accepts hex (with/without 0x,
/// 130 hex chars) with a base64 fallback.
fn decode_orbitport_signature(raw: &str) -> Result<Vec<u8>> {
    let hex_body = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(raw);

    if hex_body.len() == 130 && hex_body.chars().all(|c| c.is_ascii_hexdigit()) {
        return alloy::hex::decode(hex_body).context("hex decode of Orbitport signature failed");
    }

    B64.decode(raw).context("base64 decode of Orbitport signature failed")
}

/// Fetches a private-key secret from a 1Claw vault.
/// GET {base_url}/v1/vaults/{vault_id}/secrets/{path} → { type: "private_key", value: "0x..." }
///
/// Mirrors client.secrets.get(vaultId, signingKeyPath) in the 1Claw SDK — duplicated here
/// rather than imported, per the constraint that Permit2 signing stays local to this file.
///
/// Env vars:
///   ONECLAW_API_KEY  – vault API key (ocv_... or 1ck_...)
///   ONECLAW_BASE_URL – base URL (default: https://api.1claw.xyz)
async fn oneclaw_get_private_key(vault_id: &str, path: &str) -> Result<String> {
    let api_key = std::env::var("ONECLAW_API_KEY").context("ONECLAW_API_KEY not set")?;
    let base_url = std::env::var("ONECLAW_BASE_URL")
        .unwrap_or_else(|_| "https://api.1claw.xyz".to_string());

    let bearer = oneclaw_bearer_token(&base_url, &api_key).await?;

    let resp: Value = reqwest::Client::new()
        .get(format!("{base_url}/v1/vaults/{vault_id}/secrets/{path}"))
        .bearer_auth(&bearer)
        .send()
        .await
        .context("1Claw secrets.get request failed")?
        .error_for_status()
        .context("1Claw secrets.get returned error")?
        .json()
        .await
        .context("failed to parse 1Claw secrets.get response")?;

    let secret_type = resp["type"].as_str().unwrap_or("");
    anyhow::ensure!(
        secret_type == "private_key",
        "1Claw secret at {path} is not a private_key (type={secret_type})"
    );

    let value = resp["value"]
        .as_str()
        .context("missing value in 1Claw secret response")?;

    Ok(if value.starts_with("0x") {
        value.to_string()
    } else {
        format!("0x{value}")
    })
}

/// Polls for a transaction receipt, bounded to ~60s. Used only for the Permit2 approval step —
/// waiting for on-chain confirmation before signing/broadcasting the swap avoids racing a nonce
/// or attempting a swap that would predictably fail from insufficient allowance.
async fn wait_for_receipt(provider: &impl Provider, hash: B256) -> Result<()> {
    for _ in 0..30 {
        if let Some(receipt) = provider
            .get_transaction_receipt(hash)
            .await
            .context("eth_getTransactionReceipt failed")?
        {
            anyhow::ensure!(receipt.status(), "Permit2 approval transaction {hash:#x} reverted");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("timed out waiting for Permit2 approval transaction {hash:#x} to confirm")
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

    /// POST {base}/check_approval — returns Value with an `approval` field that is either
    /// `null` (token already trusts Permit2 for at least `amount`) or a TransactionRequest
    /// that must be signed and confirmed before the swap will succeed.
    async fn check_approval(
        &self,
        chain_id: u64,
        wallet_address: &str,
        token: &str,
        amount: &str,
    ) -> Result<Value> {
        let api_key = std::env::var("UNISWAP_API_KEY").context("UNISWAP_API_KEY not set")?;

        let resp = self
            .http
            .post(format!("{}/check_approval", uniswap_api_base()))
            .header("x-api-key", api_key)
            .header("Accept", "application/json")
            .json(&json!({
                "chainId": chain_id,
                "walletAddress": wallet_address,
                "token": token,
                "amount": amount,
            }))
            .send()
            .await
            .context("uniswap /check_approval request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("uniswap /check_approval returned {status}: {text}");
        }

        resp.json::<Value>()
            .await
            .context("uniswap /check_approval response is not JSON")
    }

    /// Signs a Uniswap `TransactionRequest`-shaped JSON value (`to`/`data`/`value`) through the
    /// agent's vault and broadcasts it. Shared by the Permit2 approval step and the final swap.
    async fn sign_and_send(
        &self,
        db: &DbPool,
        agent_id: &str,
        chain_id: u64,
        rpc_url: &str,
        provider: &impl Provider,
        tx: &Value,
    ) -> Result<B256> {
        let to: Address = tx
            .get("to")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("transaction missing 'to'"))?
            .parse()
            .context("invalid 'to' in transaction")?;

        let data: Bytes = tx
            .get("data")
            .and_then(|v| v.as_str())
            .unwrap_or("0x")
            .parse()
            .context("invalid 'data' in transaction")?;

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
        .context("signing transaction failed")?;

        let pending = provider
            .send_raw_transaction(&signed)
            .await
            .context("eth_sendRawTransaction failed")?;

        Ok(*pending.tx_hash())
    }

    async fn handle_quote(&self, args: &Map<String, Value>) -> Result<String> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("quote requires an authenticated agent"))?;
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("quote requires a database connection"))?;

        let chain_id = parse_chain_id_arg(args)
            .ok_or_else(|| anyhow::anyhow!("missing or invalid 'chainId' argument"))?;
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

        let quote = self
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

        Ok(quote.to_string())
    }

    /// Lists the `networks` table's rows as { chainId, name } pairs — the only chains
    /// `swap` can act on, since it always resolves rpc_url from this table by chainId.
    async fn handle_supported_networks(&self) -> Result<String> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("supported_networks requires a database connection"))?;

        let networks = db.list_networks().await.context("listing networks failed")?;

        let list: Vec<Value> = networks
            .into_iter()
            .map(|n| json!({ "chainId": n.chain_id, "name": n.name }))
            .collect();

        Ok(json!(list).to_string())
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

        let chain_id = parse_chain_id_arg(args)
            .ok_or_else(|| anyhow::anyhow!("missing or invalid 'chainId' argument"))?;

        // rpc_url is always resolved from the `networks` table by chainId — not a tool argument.
        let rpc_url = db
            .get_network(chain_id)
            .await
            .context("looking up network config failed")?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no network registered for chainId {chain_id} — check `supported_networks` \
                     for what's currently registered"
                )
            })?
            .rpc_url;
        let rpc_url = rpc_url.as_str();

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
        let slippage = args
            .get("slippageTolerance")
            .and_then(|v| v.as_f64())
            .unwrap_or(DEFAULT_SLIPPAGE_TOLERANCE_PCT);

        let swapper = resolve_agent_address(db, agent_id)
            .await
            .context("resolving agent wallet failed")?;
        let swapper_str = swapper.to_string();

        let provider = ProviderBuilder::new()
            .connect(rpc_url)
            .await
            .context("rpc connect failed")?;

        let mut quote_resp = self
            .fetch_quote(QuoteParams {
                chain_id,
                token_in,
                token_out,
                amount,
                swapper: &swapper_str,
                swap_type,
                slippage: Some(slippage),
            })
            .await?;
        let mut quote = quote_resp.get("quote").cloned().ok_or_else(|| {
            anyhow::anyhow!("uniswap /quote response missing 'quote' field: {quote_resp}")
        })?;

        // Layer 1: on-chain ERC-20 → Permit2 allowance. Skipped for native-currency input,
        // which never needs it. Uses the quote's resolved input amount (not the raw `amount`
        // arg) since for type=EXACT_OUTPUT the caller's amount is the *output* token's amount.
        if !token_in.eq_ignore_ascii_case(NATIVE_TOKEN_ADDRESS) {
            let required_input_amount = quote
                .get("input")
                .and_then(|i| i.get("amount"))
                .and_then(|a| a.as_str())
                .unwrap_or(amount);

            let approval_resp = self
                .check_approval(chain_id, &swapper_str, token_in, required_input_amount)
                .await?;

            if let Some(approval_tx) = approval_resp.get("approval").filter(|v| !v.is_null()) {
                let hash = self
                    .sign_and_send(db, agent_id, chain_id, rpc_url, &provider, approval_tx)
                    .await
                    .context("Permit2 token approval failed")?;

                wait_for_receipt(&provider, hash)
                    .await
                    .context("Permit2 token approval did not confirm")?;

                // The wait can take a while — refresh so pricing / Permit2 nonce / sigDeadline
                // in the quote we're about to sign against are still current.
                quote_resp = self
                    .fetch_quote(QuoteParams {
                        chain_id,
                        token_in,
                        token_out,
                        amount,
                        swapper: &swapper_str,
                        swap_type,
                        slippage: Some(slippage),
                    })
                    .await?;
                quote = quote_resp.get("quote").cloned().ok_or_else(|| {
                    anyhow::anyhow!(
                        "uniswap /quote response missing 'quote' field: {quote_resp}"
                    )
                })?;
            }
        }

        // Layer 2: off-chain, per-swap Permit2 EIP-712 signature — only when the quote needs one.
        let mut swap_body = json!({ "quote": quote });
        if let Some(permit) = quote_resp.get("permitData").filter(|v| !v.is_null()) {
            let digest = permit2_digest(permit).context("failed to compute Permit2 signing hash")?;
            let raw_sig = sign_permit_digest(db, agent_id, digest)
                .await
                .context("signing Permit2 permit failed")?;
            swap_body["signature"] = json!(alloy::hex::encode_prefixed(raw_sig));
            swap_body["permitData"] = permit.clone();
        }

        let api_key = std::env::var("UNISWAP_API_KEY").context("UNISWAP_API_KEY not set")?;

        let swap_resp = self
            .http
            .post(format!("{}/swap", uniswap_api_base()))
            .header("x-api-key", &api_key)
            .header("Accept", "application/json")
            .json(&swap_body)
            .send()
            .await
            .context("uniswap /swap request failed")?;

        if !swap_resp.status().is_success() {
            let status = swap_resp.status();
            let text = swap_resp.text().await.unwrap_or_default();
            anyhow::bail!("uniswap /swap returned {status}: {text}");
        }

        let swap_json: Value = swap_resp
            .json()
            .await
            .context("uniswap /swap response is not JSON")?;

        let tx = swap_json
            .get("swap")
            .ok_or_else(|| anyhow::anyhow!("uniswap /swap response missing 'swap' field: {swap_json}"))?;

        let hash = self
            .sign_and_send(db, agent_id, chain_id, rpc_url, &provider, tx)
            .await
            .context("signing/broadcasting swap transaction failed")?;

        Ok(json!({ "hash": format!("{hash:#x}") }).to_string())
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
                    "instructions": "Chain-agnostic Uniswap swaps. Every call takes an explicit chainId so token addresses are never ambiguous across networks. quote and swap act on the authenticated agent's own wallet, resolved automatically from its vault — you never supply a wallet/swapper address. supported_networks() lists the chainIds registered with an rpc_url (name + chainId) — swap only works on these. quote(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) returns pricing and routing for any Uniswap-supported chain, with no side effects. swap(chainId, tokenIn, tokenOut, amount, type?, slippageTolerance?) resolves rpc_url from chainId automatically, fetches a quote, transparently handles Permit2 approval/signing if needed, and signs + broadcasts the swap — you do not provide private keys, an rpc_url, or manage nonces/gas yourself.",
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

                let result = match tool_name {
                    "quote" => self.handle_quote(&args).await,
                    "swap" => self.handle_swap(&args).await,
                    "supported_networks" => self.handle_supported_networks().await,
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
                 addresses are never ambiguous across networks. quote and swap act on the \
                 authenticated agent's own wallet, resolved automatically from its vault — you \
                 never supply a wallet/swapper address. supported_networks() lists the chainIds \
                 registered with an rpc_url (name + chainId) — swap only works on these. \
                 quote(...) returns pricing and routing for any Uniswap-supported chain, with no \
                 side effects. swap(...) resolves rpc_url from chainId automatically, fetches a \
                 quote, transparently handles Permit2 approval/signing if needed, and signs + \
                 broadcasts the swap — you do not provide private keys, an rpc_url, or manage \
                 nonces/gas yourself."
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

        let result = match request.name.as_ref() {
            "quote" => self.handle_quote(&args).await,
            "swap" => self.handle_swap(&args).await,
            "supported_networks" => self.handle_supported_networks().await,
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
