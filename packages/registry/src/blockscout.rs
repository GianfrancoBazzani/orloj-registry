use std::collections::HashMap;

use alloy::json_abi::JsonAbi;
use anyhow::{Context, Result};
use serde_json::Value;
use tokio::sync::OnceCell;

pub struct BlockscoutResult {
    pub abi: JsonAbi,
    pub implementation: Option<String>,
    pub contract_name: String,
}

/// chain_id -> Blockscout instance base URL (no trailing slash).
/// Populated once per process from the public Blockscout chain registry — Blockscout
/// deployments are one-per-chain with no fixed subdomain convention (e.g. chain 10 is
/// `explorer.optimism.io`, not `optimism.blockscout.com`), so this cannot be hardcoded.
static CHAIN_EXPLORERS: OnceCell<HashMap<u64, String>> = OnceCell::const_new();

async fn fetch_blockscout_chain_registry() -> Result<HashMap<u64, String>> {
    let response = reqwest::get("https://chains.blockscout.com/api/chains")
        .await
        .context("blockscout chain registry request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!("blockscout chain registry returned {status}");
    }

    let json: Value = response
        .json()
        .await
        .context("blockscout chain registry response is not JSON")?;

    let Value::Object(chains) = json else {
        anyhow::bail!("blockscout chain registry response is not an object");
    };

    let mut map = HashMap::new();
    for (chain_id_str, entry) in chains {
        let Ok(chain_id) = chain_id_str.parse::<u64>() else {
            continue;
        };
        let Some(explorers) = entry.get("explorers").and_then(|e| e.as_array()) else {
            continue;
        };
        let url = explorers.iter().find_map(|explorer| {
            let hosted_by = explorer.get("hostedBy").and_then(|v| v.as_str());
            if hosted_by != Some("blockscout") {
                return None;
            }
            explorer
                .get("url")
                .and_then(|v| v.as_str())
                .map(|u| u.trim_end_matches('/').to_string())
        });
        if let Some(url) = url {
            map.insert(chain_id, url);
        }
    }

    Ok(map)
}

async fn explorer_base_url(chain_id: u64) -> Result<String> {
    let registry = CHAIN_EXPLORERS
        .get_or_try_init(fetch_blockscout_chain_registry)
        .await?;

    registry
        .get(&chain_id)
        .cloned()
        .with_context(|| format!("no blockscout instance known for chain {chain_id}"))
}

struct AbiOnly {
    abi: JsonAbi,
    implementation: Option<String>,
    contract_name: String,
}

/// Fetch a single contract's ABI (+ proxy pointer) from a Blockscout instance.
/// The API key, when set, is appended so the caller isn't rate-limited as an anonymous client.
async fn fetch_from(base: &str, address: &str) -> Result<AbiOnly> {
    let mut url = format!("{base}/api/v2/smart-contracts/{address}");
    if let Ok(api_key) = std::env::var("BLOCKSCOUT_API_KEY") {
        url.push_str("?apikey=");
        url.push_str(&api_key);
    }

    let response = reqwest::get(&url)
        .await
        .context("blockscout request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("blockscout returned {status}: {body}");
    }

    let json: Value = response
        .json()
        .await
        .context("blockscout response is not JSON")?;

    let contract_name = json
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("UnknownContract")
        .to_string();

    // Note the key is `address_hash`, not `address` (unlike Sourcify's proxyResolution).
    let implementation = json
        .get("implementations")
        .and_then(|arr| arr.as_array())
        .and_then(|arr| arr.first())
        .and_then(|i| i.get("address_hash"))
        .and_then(|a| a.as_str())
        .map(String::from);

    let abi: JsonAbi =
        serde_json::from_value(json.get("abi").cloned().unwrap_or(Value::Array(vec![])))
            .context("blockscout ABI parse failed")?;

    Ok(AbiOnly {
        abi,
        implementation,
        contract_name,
    })
}

/// Fetch contract metadata from Blockscout — the fallback source when Sourcify has no
/// data for a (chain_id, address) pair. Mirrors `sourcify::fetch_contract`'s proxy
/// handling: the implementation's ABI is used for tool generation, but the proxy address
/// is what callers should keep targeting (handled at the McpEntry layer, same as Sourcify).
pub async fn fetch_contract(chain_id: u64, address: &str) -> Result<BlockscoutResult> {
    let base = explorer_base_url(chain_id).await?;
    let top = fetch_from(&base, address).await?;

    if let Some(ref impl_addr) = top.implementation {
        match fetch_from(&base, impl_addr).await {
            Ok(impl_result) => {
                eprintln!(
                    "[blockscout] proxy detected: using impl ABI from {impl_addr} \
                     (proxy={address})"
                );
                return Ok(BlockscoutResult {
                    abi: impl_result.abi,
                    implementation: top.implementation,
                    contract_name: impl_result.contract_name,
                });
            }
            Err(e) => {
                eprintln!(
                    "[blockscout] proxy impl fetch failed ({impl_addr}): {e:#} — \
                     falling back to proxy ABI"
                );
            }
        }
    }

    Ok(BlockscoutResult {
        abi: top.abi,
        implementation: top.implementation,
        contract_name: top.contract_name,
    })
}
