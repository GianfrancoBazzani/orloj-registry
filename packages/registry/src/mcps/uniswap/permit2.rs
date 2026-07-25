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
//
// A wrong Permit2 digest just makes Permit2's own signature check revert on-chain — it can't
// authorize a transfer it wasn't actually signed for, so a bug here fails closed rather than
// risking funds.
//
// Signing reuses only the already-`pub` pieces of vault::sign_transaction
// (orbitport_access_token, oneclaw_bearer_token); the KMS digest call and 1Claw secret fetch
// are duplicated locally rather than exposing new surface area from the shared vault module.
// ---------------------------------------------------------------------------

use alloy::{
    primitives::{Address, B256, keccak256},
    signers::{Signer, local::PrivateKeySigner},
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};

use super::common::parse_flexible_u256;
use crate::{
    db::{DbPool, VaultInfo},
    vault::sign_transaction::{oneclaw_bearer_token, orbitport_access_token},
};

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
pub(super) fn permit2_digest(permit_data: &Value) -> Result<B256> {
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

/// Signs an arbitrary 32-byte digest (here: a Permit2 EIP-712 signing hash) with the agent's
/// vault. Returns the 65-byte ECDSA signature (r || s || v, v = 27/28) Permit2 expects.
pub(super) async fn sign_permit_digest(
    db: &DbPool,
    agent_id: &str,
    digest: B256,
) -> Result<[u8; 65]> {
    let vault = db
        .resolve_vault(agent_id)
        .await
        .context("vault resolution failed")?;

    match vault {
        VaultInfo::Orbitport {
            kms_signing_key_id, ..
        } => orbitport_sign_digest(&kms_signing_key_id, digest).await,

        VaultInfo::Oneclaw {
            vault_id,
            signing_key_path,
        } => {
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
/// Permit2 signing stays local to this module.
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
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
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

    B64.decode(raw)
        .context("base64 decode of Orbitport signature failed")
}

/// Fetches a private-key secret from a 1Claw vault.
/// GET {base_url}/v1/vaults/{vault_id}/secrets/{path} → { type: "private_key", value: "0x..." }
///
/// Mirrors client.secrets.get(vaultId, signingKeyPath) in the 1Claw SDK — duplicated here
/// rather than imported, per the constraint that Permit2 signing stays local to this module.
///
/// Env vars:
///   ONECLAW_API_KEY  – vault API key (ocv_... or 1ck_...)
///   ONECLAW_BASE_URL – base URL (default: https://api.1claw.xyz)
async fn oneclaw_get_private_key(vault_id: &str, path: &str) -> Result<String> {
    let api_key = std::env::var("ONECLAW_API_KEY").context("ONECLAW_API_KEY not set")?;
    let base_url =
        std::env::var("ONECLAW_BASE_URL").unwrap_or_else(|_| "https://api.1claw.xyz".to_string());

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
