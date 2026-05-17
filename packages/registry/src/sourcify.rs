use alloy::json_abi::JsonAbi;
use anyhow::{Context, Result};
use serde_json::Value;

pub struct SourcifyResult {
    pub abi: JsonAbi,
    pub implementation: Option<String>,
    pub contract_name: String,
}

/// Fetch contract metadata from Sourcify.
/// Called exactly once per (chain_id, address) pair — at registration time only.
/// The result is immediately persisted to Postgres; subsequent loads read from DB.
///
/// For proxy contracts: fetches the proxy to detect the implementation address,
/// then fetches the implementation's ABI. All calls still target the proxy address
/// (that is handled at the McpEntry layer). The returned `abi` is therefore the
/// implementation's ABI (the one with the real function set), and `implementation`
/// carries the resolved implementation address for reference.
pub async fn fetch_contract(chain_id: u64, address: &str) -> Result<SourcifyResult> {
    let url = format!(
        "https://sourcify.dev/server/v2/contract/{chain_id}/{address}\
         ?fields=abi,compilation,proxyResolution"
    );

    let response = reqwest::get(&url)
        .await
        .context("sourcify request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("sourcify returned {status}: {body}");
    }

    let json: Value = response
        .json()
        .await
        .context("sourcify response is not JSON")?;

    let contract_name = json
        .get("compilation")
        .and_then(|c| c.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("UnknownContract")
        .to_string();

    // Detect implementation address from proxyResolution.
    // Sourcify v2 returns `implementations` (array); fall back to singular `implementation`.
    let implementation = json.get("proxyResolution").and_then(|p| {
        let is_proxy = p.get("isProxy").and_then(|v| v.as_bool()).unwrap_or(false);
        if !is_proxy {
            return None;
        }
        // Try implementations[0].address (plural — matches JS server.mjs pattern)
        p.get("implementations")
            .and_then(|arr| arr.get(0))
            .and_then(|i| i.get("address"))
            .and_then(|a| a.as_str())
            .map(String::from)
            // Fall back to implementation.address (singular)
            .or_else(|| {
                p.get("implementation")
                    .and_then(|i| i.get("address"))
                    .and_then(|a| a.as_str())
                    .map(String::from)
            })
    });

    // For proxy contracts: fetch the implementation's ABI so tools reflect the
    // real function set. Calls still go to the proxy address (McpEntry.address).
    if let Some(ref impl_addr) = implementation {
        match fetch_abi_only(chain_id, impl_addr).await {
            Ok(impl_result) => {
                eprintln!(
                    "[sourcify] proxy detected: using impl ABI from {impl_addr} \
                     (proxy={address})"
                );
                return Ok(SourcifyResult {
                    abi: impl_result.abi,
                    implementation,
                    contract_name,
                });
            }
            Err(e) => {
                eprintln!(
                    "[sourcify] proxy impl fetch failed ({impl_addr}): {e:#} — \
                     falling back to proxy ABI"
                );
            }
        }
    }

    // Non-proxy (or impl fetch failed): use the contract's own ABI.
    let abi: JsonAbi =
        serde_json::from_value(json.get("abi").cloned().unwrap_or(Value::Array(vec![])))
            .context("sourcify ABI parse failed")?;

    Ok(SourcifyResult {
        abi,
        implementation,
        contract_name,
    })
}

struct AbiOnly {
    abi: JsonAbi,
}

/// Fetch just the ABI (+ docs) for a contract address. Used for implementation lookups.
async fn fetch_abi_only(chain_id: u64, address: &str) -> Result<AbiOnly> {
    let url = format!(
        "https://sourcify.dev/server/v2/contract/{chain_id}/{address}\
         ?fields=abi,compilation"
    );

    let response = reqwest::get(&url)
        .await
        .context("sourcify impl request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("sourcify impl returned {status}: {body}");
    }

    let json: Value = response
        .json()
        .await
        .context("sourcify impl response is not JSON")?;

    let abi: JsonAbi =
        serde_json::from_value(json.get("abi").cloned().unwrap_or(Value::Array(vec![])))
            .context("sourcify impl ABI parse failed")?;

    Ok(AbiOnly { abi })
}
