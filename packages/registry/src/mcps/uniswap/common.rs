// Shared plumbing for the Uniswap MCP: argument parsing, API base URL, and receipt polling.
// Used by both the Trading API flow (`trading`) and, later, the Liquidity API flow.

use std::time::Duration;

use alloy::{
    primitives::{B256, U256},
    providers::Provider,
};
use anyhow::{Context, Result};
use serde_json::{Map, Value};

pub(super) fn uniswap_api_base() -> String {
    std::env::var("UNISWAP_API_URL")
        .unwrap_or_else(|_| "https://trade-api.gateway.uniswap.org/v1".to_string())
}

pub(super) fn parse_flexible_u256(s: &str) -> Result<U256> {
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex) => U256::from_str_radix(hex, 16).context("invalid hex value in transaction"),
        _none => U256::from_str_radix(s, 10).context("invalid decimal value in transaction"),
    }
}

/// Reads `chainId` as either a JSON string (what the tool schema now advertises, so enum
/// dropdowns render in clients like MCP Inspector) or a JSON number (still accepted, in case
/// a client sends one despite the schema).
pub(super) fn parse_chain_id_arg(args: &Map<String, Value>) -> Option<u64> {
    match args.get("chainId") {
        Some(Value::String(s)) => s.parse().ok(),
        Some(v) => v.as_u64(),
        _none => None,
    }
}

/// Polls for a transaction receipt, bounded to ~60s. Used only for the Permit2 approval step —
/// waiting for on-chain confirmation before signing/broadcasting the swap avoids racing a nonce
/// or attempting a swap that would predictably fail from insufficient allowance.
pub(super) async fn wait_for_receipt(provider: &impl Provider, hash: B256) -> Result<()> {
    for _ in 0..30 {
        if let Some(receipt) = provider
            .get_transaction_receipt(hash)
            .await
            .context("eth_getTransactionReceipt failed")?
        {
            anyhow::ensure!(
                receipt.status(),
                "Permit2 approval transaction {hash:#x} reverted"
            );
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("timed out waiting for Permit2 approval transaction {hash:#x} to confirm")
}
