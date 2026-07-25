// Uniswap Trading API flow (https://trade-api.gateway.uniswap.org/v1 — see
// developers.uniswap.org/docs/trading/swapping-api): the `quote`, `swap` and
// `supported_networks` tools.
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
//      EIP-712 message, hashed and signed by the `permit2` module.
//   5. POST /swap with the quote (+ signature/permitData if step 4 ran), then sign + broadcast
//      the returned transaction through the same vault-signing path as EvmMcpServer write calls.

use alloy::{
    primitives::{Address, B256, Bytes, U256},
    providers::{Provider, ProviderBuilder},
};
use anyhow::{Context, Result};
use rmcp::model::*;
use serde_json::{Map, Value, json};

use super::UniswapMcpServer;
use super::common::{parse_chain_id_arg, parse_flexible_u256, uniswap_api_base, wait_for_receipt};
use super::permit2::{permit2_digest, sign_permit_digest};
use crate::{
    db::{DbPool, NetworkRow},
    vault::sign_transaction::{SignTransactionParams, resolve_agent_address, sign_transaction},
};

/// Applied to `swap` when the caller doesn't supply `slippageTolerance`. Chosen deliberately
/// rather than leaving it to whatever Uniswap's own undocumented default is, since this is the
/// value that bounds acceptable price movement for a fund-moving call.
const DEFAULT_SLIPPAGE_TOLERANCE_PCT: f64 = 0.5;

/// Sentinel used by the Uniswap Trading API for a chain's native currency (ETH, MATIC, ...).
/// Native input never needs an ERC-20 → Permit2 allowance, so `swap` skips /check_approval for it.
const NATIVE_TOKEN_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

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

pub(super) fn build_uniswap_tools(networks: &[NetworkRow]) -> Vec<Tool> {
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
// Uniswap Trading API client + handlers
// ---------------------------------------------------------------------------

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

    pub(super) async fn handle_quote(&self, args: &Map<String, Value>) -> Result<String> {
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
        let swap_type = args
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("EXACT_INPUT");
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
    pub(super) async fn handle_supported_networks(&self) -> Result<String> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("supported_networks requires a database connection"))?;

        let networks = db
            .list_networks()
            .await
            .context("listing networks failed")?;

        let list: Vec<Value> = networks
            .into_iter()
            .map(|n| json!({ "chainId": n.chain_id, "name": n.name }))
            .collect();

        Ok(json!(list).to_string())
    }

    pub(super) async fn handle_swap(&self, args: &Map<String, Value>) -> Result<String> {
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
        let swap_type = args
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("EXACT_INPUT");
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

                wait_for_receipt(&provider, hash, "Permit2 approval")
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
                    anyhow::anyhow!("uniswap /quote response missing 'quote' field: {quote_resp}")
                })?;
            }
        }

        // Layer 2: off-chain, per-swap Permit2 EIP-712 signature — only when the quote needs one.
        let mut swap_body = json!({ "quote": quote });
        if let Some(permit) = quote_resp.get("permitData").filter(|v| !v.is_null()) {
            let digest =
                permit2_digest(permit).context("failed to compute Permit2 signing hash")?;
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

        let tx = swap_json.get("swap").ok_or_else(|| {
            anyhow::anyhow!("uniswap /swap response missing 'swap' field: {swap_json}")
        })?;

        let hash = self
            .sign_and_send(db, agent_id, chain_id, rpc_url, &provider, tx)
            .await
            .context("signing/broadcasting swap transaction failed")?;

        Ok(json!({ "hash": format!("{hash:#x}") }).to_string())
    }
}
