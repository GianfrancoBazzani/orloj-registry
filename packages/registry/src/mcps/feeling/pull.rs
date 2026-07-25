// On-demand block pull.
//
// Runs `substreams run` over a bounded, recent block range and parses the decoded swaps
// straight out of stdout. No sink, no database, no daemon — the whole sentiment read is
// a single request/response operation that takes a few seconds.
//
// This is possible because a BOUNDED range terminates on its own. Streaming at chain
// head does not (it is a push stream that never completes), which is why the
// sink-into-Postgres design needs a long-running process and this one does not.
//
// ── Two CLI constraints this module is built around ────────────────────────────
//
// 1. `-s -200` ALONE IS NOT BOUNDED. A relative start with no stop block streams to
//    head forever. And `-s -200 -t +200` is rejected outright:
//    "relative end block is supported only with an absolute start block".
//    So we must resolve the head block number first and pass an ABSOLUTE range.
//
// 2. `-o jsonl` emits one JSON object per line, each wrapping a block's output in
//    `@data.swaps`. (`-o json` pretty-prints across many lines, which is far more
//    annoying to parse.)

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

/// Hard ceiling on the pull window. Each block is ~12s, so 4000 blocks is ~13 hours.
/// Bounded mostly to keep one tool call from turning into a multi-minute stream.
///
/// Note this is the ceiling on the RAW pull, and `snapshot()` requests 2x the
/// user-facing block count so the older half can serve as the previous window for
/// trend. So the largest selectable range is MAX_BLOCKS / 2 — keep this at least
/// double the biggest option the UI offers, or the two windows silently overlap and
/// the trend figure becomes meaningless.
pub const MAX_BLOCKS: u64 = 4000;
pub const DEFAULT_BLOCKS: u64 = 500;
pub const MIN_BLOCKS: u64 = 10;

/// Give up on a pull rather than hanging an MCP call indefinitely. A 200-block range
/// measured ~3s and 400 blocks ~7s, so the largest supported pull (4000 blocks, which
/// is what a 2000-block selection costs) needs real headroom — especially on a cold
/// server-side cache.
const PULL_TIMEOUT: Duration = Duration::from_secs(180);

/// One decoded swap, exactly as the Substreams module emits it.
/// Field names are the proto's camelCase JSON rendering.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledSwap {
    pub pair: String,
    pub block_number: String,
    pub timestamp: String,
    pub tx_hash: String,
    pub log_index: u32,
    pub sender: String,
    pub side: String,
    pub usdc_notional: String,
}

impl PulledSwap {
    pub fn notional(&self) -> f64 {
        self.usdc_notional.parse().unwrap_or(0.0)
    }
    pub fn block(&self) -> u64 {
        self.block_number.parse().unwrap_or(0)
    }
    pub fn is_buy(&self) -> bool {
        self.side == "BUY"
    }
}

/// Where to find the pipeline and how to reach the endpoint. All overridable by env so
/// the same binary works on a laptop and in a container.
pub struct PullConfig {
    /// Directory containing substreams.yaml.
    pub manifest_dir: String,
    /// Substreams gRPC endpoint.
    pub endpoint: String,
    /// JSON-RPC URL used ONLY to resolve the current head block number.
    pub rpc_url: String,
    /// `substreams` binary (absolute path if it is not on PATH).
    pub bin: String,
}

impl PullConfig {
    pub fn from_env() -> Self {
        Self {
            manifest_dir: std::env::var("SENTIMENT_MANIFEST_DIR")
                .unwrap_or_else(|_| "../substreams-sentiment".to_string()),
            endpoint: std::env::var("SUBSTREAMS_ENDPOINT")
                .unwrap_or_else(|_| "mainnet.eth.streamingfast.io:443".to_string()),
            rpc_url: std::env::var("ETH_RPC_URL")
                .unwrap_or_else(|_| "https://ethereum-rpc.publicnode.com".to_string()),
            bin: std::env::var("SUBSTREAMS_BIN").unwrap_or_else(|_| "substreams".to_string()),
        }
    }
}

/// Result of one pull: the swaps plus the range they came from, so callers can report
/// exactly what was measured rather than an unqualified "recent".
pub struct PullResult {
    pub swaps: Vec<PulledSwap>,
    pub from_block: u64,
    pub to_block: u64,
    pub elapsed_ms: u128,
}

/// Fetch the current head block number via `eth_blockNumber`.
///
/// Needed because the Substreams CLI will not accept a relative start with a relative
/// stop, so we cannot express "the last N blocks" without knowing where the chain is.
async fn head_block(cfg: &PullConfig) -> Result<u64> {
    let resp: Value = reqwest::Client::new()
        .post(&cfg.rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .context("eth_blockNumber request failed")?
        .error_for_status()
        .context("eth_blockNumber returned an HTTP error")?
        .json()
        .await
        .context("eth_blockNumber response was not JSON")?;

    let hex = resp["result"]
        .as_str()
        .context("eth_blockNumber response had no 'result'")?;

    u64::from_str_radix(hex.trim_start_matches("0x"), 16)
        .context("eth_blockNumber result was not hex")
}

/// Run the Substreams module over the last `blocks` blocks and return the decoded swaps.
pub async fn pull_recent_swaps(cfg: &PullConfig, blocks: u64) -> Result<PullResult> {
    let blocks = blocks.clamp(MIN_BLOCKS, MAX_BLOCKS);
    let started = std::time::Instant::now();

    let head = head_block(cfg).await?;
    let from = head.saturating_sub(blocks);
    let to = head;

    // ABSOLUTE start and stop — see the module header for why relative forms don't work.
    let child = Command::new(&cfg.bin)
        .arg("run")
        .arg("substreams.yaml")
        .arg("map_swaps")
        .arg("-e")
        .arg(&cfg.endpoint)
        .arg("-s")
        .arg(from.to_string())
        .arg("-t")
        .arg(to.to_string())
        .arg("-o")
        .arg("jsonl")
        .current_dir(&cfg.manifest_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| {
            format!(
                "failed to launch `{}` — is the Substreams CLI installed and on PATH? \
                 (override with SUBSTREAMS_BIN)",
                cfg.bin
            )
        })?;

    let output = tokio::time::timeout(PULL_TIMEOUT, child.wait_with_output())
        .await
        .with_context(|| {
            format!(
                "substreams run exceeded {}s for blocks {from}..{to}",
                PULL_TIMEOUT.as_secs()
            )
        })?
        .context("substreams run failed")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Surface the most useful line rather than a wall of log output. Auth failures
        // are by far the most common cause, so name the fix explicitly.
        let hint = if stderr.contains("invalid JWT") || stderr.contains("Unauthenticated") {
            " — SUBSTREAMS_API_TOKEN is missing or expired. Note the raw API key does \
             NOT work: exchange it at https://auth.streamingfast.io/v1/auth/issue first."
        } else {
            ""
        };
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        anyhow::bail!(
            "substreams run failed ({}){hint}: {}",
            output.status,
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        );
    }

    let swaps = parse_jsonl(&String::from_utf8_lossy(&output.stdout));

    Ok(PullResult {
        swaps,
        from_block: from,
        to_block: to,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Parse `-o jsonl` output: one JSON object per line, each shaped
/// `{"@module":..., "@block":..., "@data":{"swaps":[...]}}`.
///
/// Malformed or unexpected lines are skipped rather than failing the whole pull — the
/// CLI may interleave progress or diagnostic lines, and losing one block's data is
/// better than returning nothing.
pub fn parse_jsonl(stdout: &str) -> Vec<PulledSwap> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(items) = v.pointer("/@data/swaps").and_then(|s| s.as_array()) else {
            continue;
        };
        for item in items {
            if let Ok(swap) = serde_json::from_value::<PulledSwap>(item.clone()) {
                out.push(swap);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real line captured from `substreams run ... -o jsonl` against mainnet.
    const REAL_LINE: &str = r#"{"@module":"map_swaps","@block":25611990,"@type":"market.sentiment.v1.Swaps","@data":{"swaps":[{"pool":"0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640","pair":"WETH/USDC","blockNumber":"25611990","blockHash":"f398","timestamp":"1785009035","txHash":"8d75","logIndex":40,"sender":"0x09ad","recipient":"0x09ad","amount0":"-3177075410","amount1":"1696531636627541993","side":"SELL","usdcNotional":"3177.075410"},{"pool":"0x88e6","pair":"WETH/USDC","blockNumber":"25611990","blockHash":"f398","timestamp":"1785009035","txHash":"3d89","logIndex":8,"sender":"0x68b3","recipient":"0xf928","amount0":"297000000","amount1":"-158440284045789146","side":"BUY","usdcNotional":"297.000000"}]}}"#;

    #[test]
    fn parses_real_cli_output() {
        let swaps = parse_jsonl(REAL_LINE);
        assert_eq!(swaps.len(), 2);

        assert_eq!(swaps[0].side, "SELL");
        assert_eq!(swaps[0].notional(), 3177.075410);
        assert_eq!(swaps[0].block(), 25_611_990);
        assert_eq!(swaps[0].log_index, 40);
        assert!(!swaps[0].is_buy());

        assert_eq!(swaps[1].side, "BUY");
        assert_eq!(swaps[1].notional(), 297.0);
        assert!(swaps[1].is_buy());
    }

    #[test]
    fn skips_noise_without_losing_valid_lines() {
        let mixed = format!("not json\n\n{{\"other\":1}}\n{REAL_LINE}\n[]\n");
        assert_eq!(parse_jsonl(&mixed).len(), 2);
    }

    #[test]
    fn empty_output_is_empty_not_an_error() {
        assert!(parse_jsonl("").is_empty());
        assert!(parse_jsonl("\n\n").is_empty());
    }

    #[test]
    fn block_count_is_clamped_to_sane_bounds() {
        assert_eq!(0u64.clamp(MIN_BLOCKS, MAX_BLOCKS), MIN_BLOCKS);
        assert_eq!(999_999u64.clamp(MIN_BLOCKS, MAX_BLOCKS), MAX_BLOCKS);
        assert_eq!(DEFAULT_BLOCKS.clamp(MIN_BLOCKS, MAX_BLOCKS), DEFAULT_BLOCKS);
    }
}
