use alloy::json_abi::JsonAbi;
use anyhow::Result;

use crate::{blockscout, blockscout::BlockscoutResult, sourcify, sourcify::SourcifyResult};

pub struct ContractSource {
    pub abi: JsonAbi,
    pub implementation: Option<String>,
    pub contract_name: String,
}

impl From<SourcifyResult> for ContractSource {
    fn from(r: SourcifyResult) -> Self {
        ContractSource {
            abi: r.abi,
            implementation: r.implementation,
            contract_name: r.contract_name,
        }
    }
}

impl From<BlockscoutResult> for ContractSource {
    fn from(r: BlockscoutResult) -> Self {
        ContractSource {
            abi: r.abi,
            implementation: r.implementation,
            contract_name: r.contract_name,
        }
    }
}

/// Fetch contract metadata, trying Sourcify first and falling back to Blockscout when
/// Sourcify has no data for a (chain_id, address) pair (not every verified contract is
/// indexed by Sourcify). Any Sourcify failure — network error, non-2xx, unparsable
/// response — triggers the Blockscout attempt.
pub async fn fetch_contract(chain_id: u64, address: &str) -> Result<ContractSource> {
    match sourcify::fetch_contract(chain_id, address).await {
        Ok(r) => return Ok(r.into()),
        Err(e) => eprintln!(
            "[abi] sourcify lookup failed for {chain_id}/{address}: {e:#} — trying blockscout"
        ),
    }

    match blockscout::fetch_contract(chain_id, address).await {
        Ok(r) => return Ok(r.into()),
        Err(e) => eprintln!("[abi] blockscout lookup failed for {chain_id}/{address}: {e:#}"),
    }

    anyhow::bail!("contract not verified on Sourcify or Blockscout")
}
