// Transaction signing dispatcher — mirrors sign-transaction.js.
//
// sign_transaction() resolves the calling agent's vault via DbPool::resolve_vault
// and delegates to the appropriate backend:
//
//   VaultInfo::Orbitport → sign_with_orbitport   (KMS digest signing via Space Computer JSON-RPC)
//   VaultInfo::Oneclaw   → sign_with_oneclaw     (private key fetched from 1Claw, sign locally)

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSigner,
    primitives::{Address, Bytes, Signature, TxKind, U256},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD as B64};

use crate::db::{DbPool, VaultInfo};

// ---------------------------------------------------------------------------
// Address resolution (used by native_mcp for getBalance)
// ---------------------------------------------------------------------------

/// Return the EVM address that an agent's vault controls, without signing anything.
pub async fn resolve_agent_address(db: &DbPool, agent_id: &str) -> Result<Address> {
    let vault = db
        .resolve_vault(agent_id)
        .await
        .context("vault resolution failed")?;

    match vault {
        VaultInfo::Orbitport { address, .. } => {
            address.parse().context("invalid Orbitport address in vault")
        }
        VaultInfo::Oneclaw { vault_id, signing_key_path } => {
            let private_key = oneclaw_get_secret(&vault_id, &signing_key_path).await?;
            let signer: PrivateKeySigner =
                private_key.parse().context("invalid private key from 1Claw")?;
            Ok(signer.address())
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Mirrors the destructured argument of signTransaction() in sign-transaction.js.
pub struct SignTransactionParams {
    pub agent_id: String,
    pub chain_id: u64,
    /// HTTP or WebSocket RPC endpoint for the target chain.
    pub rpc_url: String,
    pub to: Address,
    /// Value in wei (default: U256::ZERO).
    pub value: U256,
    /// ABI-encoded calldata (default: empty).
    pub data: Bytes,
    /// Explicit nonce; None → fetch pending nonce from the network.
    pub nonce: Option<u64>,
}

/// Resolve the agent's vault and sign an EIP-1559 transaction.
/// Returns the raw EIP-2718 encoded signed tx, ready for `eth_sendRawTransaction`.
pub async fn sign_transaction(db: &DbPool, params: SignTransactionParams) -> Result<Bytes> {
    let vault = db
        .resolve_vault(&params.agent_id)
        .await
        .context("vault resolution failed")?;

    match vault {
        VaultInfo::Orbitport { kms_signing_key_id, address, .. } => {
            sign_with_orbitport(OrbitportSignParams {
                kms_signing_key_id,
                address,
                chain_id: params.chain_id,
                rpc_url: params.rpc_url,
                to: params.to,
                value: params.value,
                data: params.data,
                nonce: params.nonce,
            })
            .await
        }

        VaultInfo::Oneclaw { vault_id, signing_key_path } => {
            sign_with_oneclaw(OneclawSignParams {
                vault_id,
                signing_key_path,
                chain_id: params.chain_id,
                rpc_url: params.rpc_url,
                to: params.to,
                value: params.value,
                data: params.data,
                nonce: params.nonce,
            })
            .await
        }
    }
}

// ---------------------------------------------------------------------------
// Orbitport backend — mirrors vault-providers/orbitport.js signWithOrbitport()
// ---------------------------------------------------------------------------

pub struct OrbitportSignParams {
    /// From the `kms_signing_key_id` column in `orbitport_vault`.
    pub kms_signing_key_id: String,
    /// On-chain address controlled by that KMS key (checksummed string).
    pub address: String,
    pub chain_id: u64,
    pub rpc_url: String,
    pub to: Address,
    pub value: U256,
    pub data: Bytes,
    pub nonce: Option<u64>,
}

/// Sign via the Space Computer / Orbitport KMS API.
///
/// JS flow (orbitport.js):
///   1. In parallel: pending nonce, estimateFeesPerGas, estimateGas.
///   2. Build unsigned EIP-1559 tx → signature_hash() → 32-byte digest.
///   3. JSON-RPC 2.0: POST {ORBITPORT_API_URL}/api/v1/rpc  method=kms.Sign
///      { KeyId, Message: base64(digest), SigningAlgorithm: "ETHEREUM_SECP256K1", MessageType: "DIGEST" }
///   4. Decode 65-byte signature from result.Signature (hex or base64).
///   5. Normalise v → yParity, reassemble with r/s, re-encode tx.
///
/// Env vars:
///   ORBITPORT_CLIENT_ID      – OAuth2 client ID
///   ORBITPORT_CLIENT_SECRET  – OAuth2 client secret
///   ORBITPORT_API_URL        – KMS base URL  (default: https://op.spacecomputer.io/api)
///   ORBITPORT_AUTH_URL       – OAuth token URL (default: https://auth.spacecomputer.io/oauth/token)
async fn sign_with_orbitport(params: OrbitportSignParams) -> Result<Bytes> {
    let provider = ProviderBuilder::new()
        .connect(&params.rpc_url)
        .await
        .context("rpc connect failed")?;

    let from: Address = params.address.parse().context("invalid Orbitport address")?;

    let tx_req = TransactionRequest::default()
        .from(from)
        .to(params.to)
        .value(params.value)
        .input(params.data.clone().into());

    // Fetch nonce, fees, gas in parallel.
    let (nonce, fees, gas) = tokio::try_join!(
        async {
            Ok::<u64, anyhow::Error>(match params.nonce {
                Some(n) => n,
                None => provider
                    .get_transaction_count(from)
                    .await
                    .context("get_transaction_count failed")?,
            })
        },
        async {
            provider
                .estimate_eip1559_fees()
                .await
                .context("estimate_eip1559_fees failed")
        },
        async {
            provider
                .estimate_gas(tx_req.clone())
                .await
                .context("estimate_gas failed")
        },
    )?;

    let tx = TxEip1559 {
        chain_id: params.chain_id,
        nonce,
        gas_limit: gas,
        max_fee_per_gas: fees.max_fee_per_gas,
        max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
        to: TxKind::Call(params.to),
        value: params.value,
        input: params.data,
        access_list: Default::default(),
    };

    // keccak256 of the RLP-encoded unsigned tx envelope (same as viem's serializeTransaction + keccak256).
    let digest = tx.signature_hash();

    let token = orbitport_access_token().await?;

    // SDK default: apiUrl = "https://op.spacecomputer.io", KMS endpoint = {apiUrl}/api/v1/rpc
    let api_url = std::env::var("ORBITPORT_API_URL")
        .unwrap_or_else(|_| "https://op.spacecomputer.io".to_string());

    // JSON-RPC 2.0 — mirrors KMSService._callRaw("kms.Sign", ...) in the Orbitport SDK.
    // Message must be base64-encoded (SDK: toBase64(sanitized.message)).
    let resp: serde_json::Value = reqwest::Client::new()
        .post(format!("{api_url}/api/v1/rpc"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "kms.Sign",
            "params": {
                "KeyId": params.kms_signing_key_id,
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

    // JSON-RPC errors come back with HTTP 200 — surface them explicitly.
    if let Some(err) = resp.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        anyhow::bail!("Orbitport kms.Sign JSON-RPC error {code}: {msg}");
    }

    let raw_sig = resp["result"]["Signature"]
        .as_str()
        .context("missing Signature in Orbitport kms.Sign result")?;

    let sig_bytes = decode_orbitport_signature(raw_sig)?;
    ensure!(sig_bytes.len() == 65, "Orbitport signature length is {} (want 65)", sig_bytes.len());

    let r = alloy::primitives::U256::from_be_slice(&sig_bytes[0..32]);
    let s = alloy::primitives::U256::from_be_slice(&sig_bytes[32..64]);
    let v_raw = sig_bytes[64];
    // Normalise raw v: subtract 27 if ≥ 27 to get yParity ∈ {0, 1}.
    let y_parity = if v_raw < 27 { v_raw != 0 } else { (v_raw - 27) != 0 };

    let sig = Signature::new(r, s, y_parity);
    let signed = tx.into_signed(sig);
    Ok(TxEnvelope::Eip1559(signed).encoded_2718().into())
}

// ---------------------------------------------------------------------------
// 1Claw backend — mirrors vault-providers/oneclaw.js signWithOneclaw()
// ---------------------------------------------------------------------------

pub struct OneclawSignParams {
    pub vault_id: String,
    pub signing_key_path: String,
    pub chain_id: u64,
    pub rpc_url: String,
    pub to: Address,
    pub value: U256,
    pub data: Bytes,
    pub nonce: Option<u64>,
}

/// Fetch the private key from the 1Claw vault and sign locally.
///
/// JS flow (oneclaw.js):
///   1. client.secrets.get(vaultId, signingKeyPath)
///      → GET {base_url}/v1/vaults/{vaultId}/secrets/{path}
///      → body: { type: "private_key", value: "0x..." }
///   2. privateKeyToAccount(privateKey) → local signer
///   3. In parallel: pending nonce, estimateFeesPerGas, estimateGas
///   4. account.signTransaction(eip1559Tx) → RLP-encoded signed tx
///
/// Env vars:
///   ONECLAW_API_KEY    – vault API key (ocv_... or 1ck_...)
///   ONECLAW_BASE_URL – base URL (default: https://api.1claw.xyz)
async fn sign_with_oneclaw(params: OneclawSignParams) -> Result<Bytes> {
    let private_key = oneclaw_get_secret(&params.vault_id, &params.signing_key_path).await?;

    let signer: PrivateKeySigner = private_key
        .parse()
        .context("invalid private key returned from 1Claw")?;
    let from = signer.address();

    let provider = ProviderBuilder::new()
        .connect(&params.rpc_url)
        .await
        .context("rpc connect failed")?;

    let tx_req = TransactionRequest::default()
        .from(from)
        .to(params.to)
        .value(params.value)
        .input(params.data.clone().into());

    let (nonce, fees, gas) = tokio::try_join!(
        async {
            Ok::<u64, anyhow::Error>(match params.nonce {
                Some(n) => n,
                None => provider
                    .get_transaction_count(from)
                    .await
                    .context("get_transaction_count failed")?,
            })
        },
        async {
            provider
                .estimate_eip1559_fees()
                .await
                .context("estimate_eip1559_fees failed")
        },
        async {
            provider
                .estimate_gas(tx_req.clone())
                .await
                .context("estimate_gas failed")
        },
    )?;

    let mut tx = TxEip1559 {
        chain_id: params.chain_id,
        nonce,
        gas_limit: gas,
        max_fee_per_gas: fees.max_fee_per_gas,
        max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
        to: TxKind::Call(params.to),
        value: params.value,
        input: params.data,
        access_list: Default::default(),
    };

    let sig = signer
        .sign_transaction(&mut tx)
        .await
        .context("local signing failed")?;

    let signed = tx.into_signed(sig);
    Ok(TxEnvelope::Eip1559(signed).encoded_2718().into())
}

// ---------------------------------------------------------------------------
// Orbitport HTTP helpers
// ---------------------------------------------------------------------------

/// Obtain a short-lived OAuth2 access token from Space Computer using client credentials.
///
/// Mirrors AuthService.requestNewToken() in the Orbitport SDK:
///   - POST https://auth.spacecomputer.io/oauth/token
///   - Content-Type: application/json  (NOT form-encoded)
///   - Body: { client_id, client_secret, audience, grant_type }
///   - audience defaults to "https://op.spacecomputer.io/api" (required by Auth0)
pub async fn orbitport_access_token() -> Result<String> {
    let client_id = std::env::var("ORBITPORT_CLIENT_ID").context("ORBITPORT_CLIENT_ID not set")?;
    let client_secret =
        std::env::var("ORBITPORT_CLIENT_SECRET").context("ORBITPORT_CLIENT_SECRET not set")?;
    let auth_url = std::env::var("ORBITPORT_AUTH_URL")
        .unwrap_or_else(|_| "https://auth.spacecomputer.io/oauth/token".to_string());
    let audience = std::env::var("ORBITPORT_AUDIENCE")
        .unwrap_or_else(|_| "https://op.spacecomputer.io/api".to_string());

    let resp: serde_json::Value = reqwest::Client::new()
        .post(&auth_url)
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "audience": audience,
            "grant_type": "client_credentials",
        }))
        .send()
        .await
        .context("Orbitport OAuth token request failed")?
        .error_for_status()
        .context("Orbitport OAuth token endpoint returned error")?
        .json()
        .await
        .context("failed to parse Orbitport OAuth token response")?;

    resp["access_token"]
        .as_str()
        .context("missing access_token in Orbitport OAuth response")
        .map(str::to_string)
}

/// Decode Orbitport's 65-byte signature.
/// Accepts hex (with or without 0x, 130 hex chars) with a base64 fallback.
/// Mirrors decodeSignature() in vault-providers/orbitport.js.
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

// ---------------------------------------------------------------------------
// 1Claw HTTP helpers
// ---------------------------------------------------------------------------

/// Exchange a 1Claw API key for a short-lived JWT Bearer token.
///
/// - `ocv_` (vault/agent) keys → POST /v1/auth/agent-token   { api_key }
/// - `1ck_` (human) keys      → POST /v1/auth/api-key-token  { api_key }
///
/// Both responses return `{ "access_token": "..." }`.
/// Mirrors HttpClient.ensureToken() and auth.apiKeyToken() in the 1Claw SDK.
pub async fn oneclaw_bearer_token(base_url: &str, api_key: &str) -> Result<String> {
    let client = reqwest::Client::new();

    let endpoint = if api_key.starts_with("ocv_") {
        format!("{base_url}/v1/auth/agent-token")
    } else {
        format!("{base_url}/v1/auth/api-key-token")
    };

    let resp: serde_json::Value = client
        .post(&endpoint)
        .json(&serde_json::json!({ "api_key": api_key }))
        .send()
        .await
        .context("1Claw auth token request failed")?
        .error_for_status()
        .context("1Claw auth token endpoint returned error")?
        .json()
        .await
        .context("failed to parse 1Claw auth token response")?;

    resp["access_token"]
        .as_str()
        .context("missing access_token in 1Claw auth response")
        .map(str::to_string)
}

/// Fetch a private key secret from a 1Claw vault.
///
/// REST: GET {base_url}/v1/vaults/{vault_id}/secrets/{path}
/// Response body (raw, no SDK envelope): { "type": "private_key", "value": "0x..." }
///
/// Mirrors client.secrets.get(vaultId, signingKeyPath) in the 1Claw SDK (secrets.js).
async fn oneclaw_get_secret(vault_id: &str, path: &str) -> Result<String> {
    let api_key = std::env::var("ONECLAW_API_KEY").context("ONECLAW_API_KEY not set")?;
    let base_url = std::env::var("ONECLAW_BASE_URL")
        .unwrap_or_else(|_| "https://api.1claw.xyz".to_string());

    let bearer = oneclaw_bearer_token(&base_url, &api_key).await?;

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
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

    // Raw HTTP response body: { "type": "private_key", "value": "0x...", ... }
    let secret_type = resp["type"].as_str().unwrap_or("");
    ensure!(
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
