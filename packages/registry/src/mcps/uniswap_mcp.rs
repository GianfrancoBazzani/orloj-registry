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
//      below) and signed via the vault's generic sign_digest() — no raw keys leave the vault.
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

use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::keccak256;
use alloy::{
    primitives::{Address, B256, Bytes, U256},
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
    vault::sign_transaction::{
        SignTransactionParams, resolve_agent_address, sign_digest, sign_transaction,
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
        "Execute a Uniswap swap on behalf of the authenticated agent — fully automatic, no separate approval call needed. Resolves the agent's own wallet, gets a quote, transparently handles both Permit2 layers if required (on-chain ERC-20→Permit2 approval, signed off-chain via the vault if the token needs it — waits for it to confirm; then the per-swap Permit2 EIP-712 signature, also signed via the vault), then signs and broadcasts the swap transaction.".to_string(),
        {
            let mut props = Map::new();
            props.insert("chainId".to_string(), chain_id_prop);
            props.insert(
                "rpcUrl".to_string(),
                json!({
                    "type": "string",
                    "description": "HTTPS or WSS RPC endpoint for `chainId`, used to sign and broadcast the swap (and, if needed, the Permit2 approval) transaction."
                }),
            );
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
        Some(hex) => U256::from_str_radix(hex, 16).context("invalid hex value in transaction"),
        _none => U256::from_str_radix(s, 10).context("invalid decimal value in transaction"),
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
