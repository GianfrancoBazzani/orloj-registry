// Shared plumbing for the Uniswap MCP: argument parsing, API base URL, and receipt polling.
// Used by both the Trading API flow (`trading`) and, later, the Liquidity API flow.

use std::time::Duration;

use alloy::{
    primitives::{B256, U256},
    providers::Provider,
    rpc::types::TransactionReceipt,
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

/// Polls for a transaction receipt, bounded to ~60s, and fails if the transaction reverted.
///
/// `label` names the transaction in error messages ("Permit2 approval", "position create", ...)
/// so a timeout or revert says which step of a multi-transaction flow stalled.
///
/// Waiting matters wherever a later transaction depends on an earlier one: broadcasting a swap
/// or a mint before its approval has confirmed either races the nonce or predictably reverts on
/// insufficient allowance. The receipt is returned rather than discarded because callers that
/// mint an NFT need its logs to learn the new token id.
pub(super) async fn wait_for_receipt(
    provider: &impl Provider,
    hash: B256,
    label: &str,
) -> Result<TransactionReceipt> {
    for _ in 0..30 {
        if let Some(receipt) = provider
            .get_transaction_receipt(hash)
            .await
            .context("eth_getTransactionReceipt failed")?
        {
            anyhow::ensure!(receipt.status(), "{label} transaction {hash:#x} reverted");
            return Ok(receipt);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("timed out waiting for {label} transaction {hash:#x} to confirm")
}
