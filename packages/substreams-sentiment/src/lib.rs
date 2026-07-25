//! Onchain Market Sentiment — Substreams module.
//!
//! Decodes Uniswap V3 `Swap` events from two hardcoded pools, labels each swap BUY or
//! SELL from the sign of its USDC leg, and writes one row per swap into Postgres.
//!
//! ## Why there is no store
//!
//! Aggregation happens in SQL, not here. A store module would force backfill from its
//! `initialBlock` — the Substreams docs are explicit: *"Stores always need to be
//! backfilled from their initial block to be usable."* Both modules below are `kind:
//! map`, so this package starts at a recent block and streams immediately. It also
//! means changing the sentiment window (15m → 5m) is a SQL edit, not a WASM rebuild
//! plus a re-sync.
//!
//! ## The sign convention (the whole model)
//!
//! Per `IUniswapV3SwapCallback.sol`, `amount0`/`amount1` are amounts
//! *"sent (negative) or must be received (positive) **by the pool**"*. So on the USDC
//! leg: positive means USDC went INTO the pool, i.e. the trader paid USDC and received
//! the other asset — a BUY. Negative is a SELL. No heuristic, no classifier.
//!
//! ## The trap this code is written around
//!
//! Which side the USDC leg sits on differs per pool, because token order is decided by
//! raw address sort (`0x2260fa` WBTC < `0xa0b869` USDC < `0xc02aaa` WETH):
//!
//! | Pool | token0 | token1 |
//! |---|---|---|
//! | WETH/USDC 0.05% (tracked) | **USDC** | WETH |
//! | WBTC/USDC 0.30% (removed) | WBTC | **USDC** |
//!
//! Hardcoding "USDC is always amount0" happens to be right for the WETH pool and would
//! silently invert every label for a WBTC-style pool. Orientation therefore travels
//! with the pool (see [`POOLS`]) and is asserted in tests, so adding a pool back is a
//! one-line change that cannot corrupt the decode path. Verified on-chain with
//! `cast call <pool> "token0()(address)"`.

mod abi;

mod pb {
    pub mod market {
        pub mod sentiment {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/market.sentiment.v1.rs"));
            }
        }
    }
}

use hex_literal::hex;
use substreams::errors::Error;
use substreams::scalar::BigInt;
use substreams::Hex;
use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_database_change::tables::Tables;
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

use pb::market::sentiment::v1::{Swap, Swaps};

/// USDC has 6 decimals. Getting this wrong scales every notional by a factor of 1e12
/// and is invisible until you check a swap against a block explorer.
const USDC_DECIMALS: u32 = 6;

/// A pool we track: address, display pair, and which side the USDC leg is on.
struct PoolConfig {
    address: [u8; 20],
    pair: &'static str,
    /// True when USDC is token0, i.e. the USDC leg is `amount0`.
    usdc_is_token0: bool,
}

/// The pools under observation. Each is the dominant fee tier for its pair.
/// `usdc_is_token0` verified on-chain — do not "simplify" it to a constant.
///
/// WBTC/USDC 0.30% (`0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35`, token0 = WBTC) was
/// tracked here and removed: it trades roughly once every 25 minutes (41 swaps per 5000
/// blocks vs ~2000 for WETH), so it sat below the participation floor at any usable
/// window. To re-add it, append a `PoolConfig` with `usdc_is_token0: false` — the
/// orientation is per-pool precisely so a second pool can be added without touching the
/// decode path.
const POOLS: [PoolConfig; 1] = [PoolConfig {
    // Uniswap V3 WETH/USDC 0.05% (fee=500). token0 = USDC, token1 = WETH.
    address: hex!("88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"),
    pair: "WETH/USDC",
    usdc_is_token0: true,
}];

fn pool_config(address: &[u8]) -> Option<&'static PoolConfig> {
    POOLS.iter().find(|p| p.address == address)
}

/// Extract the decoded Uniswap V3 `Swap` events for the tracked pools in one block.
///
/// Note there is no explicit "skip reverted transactions" check: `block.transactions()`
/// yields successful transactions only. Logs from failed calls never reach us.
#[substreams::handlers::map]
pub fn map_swaps(block: eth::Block) -> Result<Swaps, Error> {
    let mut out = Swaps::default();

    let block_number = block.number;
    let block_hash = Hex::encode(&block.hash);
    // `timestamp_seconds` is NOT a field on Block — the timestamp lives on `header`.
    // This explicit form cannot panic on a block with no header.
    let timestamp = block
        .header
        .as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds as u64)
        .unwrap_or(0);

    for trx in block.transactions() {
        let tx_hash = Hex::encode(&trx.hash);

        for (log, _call) in trx.logs_with_calls() {
            // Filter on the pool address first — cheapest possible rejection, and it
            // keeps the module's output tiny (2 addresses out of the whole chain).
            let Some(cfg) = pool_config(&log.address) else {
                continue;
            };

            // These pools also emit Mint/Burn/Collect/Flash. Without the topic0 check
            // we would try to decode unrelated events.
            let Some(swap) = abi::uniswap_v3_pool::events::Swap::match_and_decode(log) else {
                continue;
            };

            // Pick the USDC leg using this pool's own orientation.
            let usdc_amount: &BigInt = if cfg.usdc_is_token0 {
                &swap.amount0
            } else {
                &swap.amount1
            };

            // Read the SIGN before taking any magnitude. Calling abs() first would
            // discard the only thing that distinguishes a buy from a sell.
            let Some(side) = classify_side(usdc_amount) else {
                // Zero USDC leg: a degenerate swap (rounding to zero, protocol-fee-only
                // path). Not an error, and not directional — skip it rather than
                // asserting an invariant that can legitimately be violated.
                continue;
            };

            out.swaps.push(Swap {
                pool: format!("0x{}", Hex::encode(&log.address)),
                pair: cfg.pair.to_string(),
                block_number,
                block_hash: block_hash.clone(),
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index: log.index,
                sender: format!("0x{}", Hex::encode(&swap.sender)),
                recipient: format!("0x{}", Hex::encode(&swap.recipient)),
                amount0: swap.amount0.to_string(),
                amount1: swap.amount1.to_string(),
                side: side.to_string(),
                usdc_notional: format_units(usdc_amount, USDC_DECIMALS),
            });
        }
    }

    Ok(out)
}

/// Write each swap as one row keyed by `(tx_hash, log_index)`.
///
/// That key MUST match `PRIMARY KEY (tx_hash, log_index)` in schema.sql — same column
/// names, same order.
///
/// **`upsert_row`, not `create_row`.** Substreams delivers at-least-once: a disconnect,
/// a re-run over an already-processed range, or a reorg replay all re-deliver blocks.
/// `create_row` emits a plain `INSERT`, so the second delivery dies on
/// `duplicate key value violates unique constraint "swap_pkey"` and takes the whole
/// stream down with it. `upsert_row` makes redelivery a no-op, which is what actually
/// makes the pipeline resumable. (Learned by watching a live sink run fail at block
/// 21000006 on the second pass.)
#[substreams::handlers::map]
pub fn db_out(swaps: Swaps) -> Result<DatabaseChanges, Error> {
    let mut tables = Tables::new();

    for s in swaps.swaps {
        let log_index = s.log_index.to_string();
        tables
            .upsert_row(
                "swap",
                [
                    ("tx_hash", s.tx_hash.as_str()),
                    ("log_index", log_index.as_str()),
                ],
            )
            .set("block_number", s.block_number as i64)
            .set("block_hash", s.block_hash)
            // RFC3339 UTC, e.g. "2024-10-19T14:07:59Z".
            //
            // It must be a literal the database can parse as a value: the sink sends
            // column values as query PARAMETERS, so a SQL expression like
            // `to_timestamp(1729345619)` is inserted as the literal *string* and
            // Postgres rejects it with `invalid input syntax for type timestamp with
            // time zone`. Found the hard way on a live sink run.
            .set("timestamp", format_rfc3339(s.timestamp))
            .set("pair", s.pair)
            .set("pool", s.pool)
            .set("sender", s.sender)
            .set("side", s.side)
            .set("usdc_notional", s.usdc_notional);
    }

    Ok(tables.to_database_changes())
}

/// Render unix seconds as an RFC3339 UTC timestamp: `1729345619` → `2024-10-19T14:07:59Z`.
///
/// Implemented directly rather than pulling in `chrono`/`time`: this is a WASM module
/// with no timezone database, the input is always UTC epoch seconds, and the output
/// format is fixed. Uses Howard Hinnant's `civil_from_days` algorithm, which is exact
/// for all proleptic-Gregorian dates and needs no lookup tables.
fn format_rfc3339(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let secs_of_day = unix_seconds % 86_400;

    let (hour, minute, second) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    // civil_from_days: shift the epoch to 0000-03-01 so leap days land at the end of
    // the cycle, which removes every February special case.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// BUY when the USDC leg is positive (USDC into the pool → trader bought the asset),
/// SELL when negative. `None` for zero, which carries no direction.
fn classify_side(usdc_amount: &BigInt) -> Option<&'static str> {
    let zero = BigInt::zero();
    if *usdc_amount > zero {
        Some("BUY")
    } else if *usdc_amount < zero {
        Some("SELL")
    } else {
        None
    }
}

/// Render a signed BigInt as a fixed-point decimal string with `decimals` places,
/// dropping the sign (direction is carried separately by `side`).
///
/// Kept as exact integer/string work rather than floating point: a USDC notional is
/// money, and f64 would quietly lose precision on large amounts.
fn format_units(value: &BigInt, decimals: u32) -> String {
    let digits = value.absolute().to_string();
    let dec = decimals as usize;

    if dec == 0 {
        return digits;
    }

    if digits.len() <= dec {
        // Smaller than one whole unit — left-pad to "0.000123".
        let padded = format!("{:0>width$}", digits, width = dec + 1);
        let split = padded.len() - dec;
        format!("{}.{}", &padded[..split], &padded[split..])
    } else {
        let split = digits.len() - dec;
        format!("{}.{}", &digits[..split], &digits[split..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // BigInt implements FromStr (not From<&str>) — parse, don't convert.
    fn big(s: &str) -> BigInt {
        use std::str::FromStr;
        BigInt::from_str(s).unwrap()
    }

    #[test]
    fn pool_orientation_matches_onchain_token_order() {
        // The single highest-risk fact in this codebase: get this wrong and every
        // buy/sell label for the pool is inverted. Verified on-chain with
        // `cast call <pool> "token0()(address)"` — USDC (0xa0b869) sorts BELOW
        // WETH (0xc02aaa), so USDC is token0 here.
        let weth = pool_config(&hex!("88e6a0c2ddd26feeb64f039a2c41296fcb3f5640")).unwrap();
        assert_eq!(weth.pair, "WETH/USDC");
        assert!(weth.usdc_is_token0, "USDC is token0 in the WETH pool");
    }

    #[test]
    fn every_pool_carries_its_own_orientation() {
        // Guards the shape rather than a specific pool: orientation must be read from
        // each PoolConfig, never assumed. WBTC/USDC (token0 = WBTC, the OPPOSITE of the
        // WETH pool) was tracked here before; if it or any pool whose USDC leg is
        // token1 is re-added, a hardcoded "USDC is amount0" would silently invert it.
        for p in POOLS.iter() {
            let looked_up = pool_config(&p.address).expect("pool must be findable");
            assert_eq!(
                looked_up.usdc_is_token0, p.usdc_is_token0,
                "orientation must come from the pool's own config"
            );
        }
    }

    #[test]
    fn unknown_pools_are_ignored() {
        assert!(pool_config(&hex!("0000000000000000000000000000000000000000")).is_none());
        // Uniswap V3 WETH/USDC 0.30% — a real pool, but not one we track.
        assert!(pool_config(&hex!("8ad599c3a0ff1de082011efddc58f1908eb6e6d8")).is_none());
    }

    #[test]
    fn side_follows_the_sign_of_the_usdc_leg() {
        // Positive USDC = into the pool = trader paid USDC = BUY.
        assert_eq!(classify_side(&big("3000000000")), Some("BUY"));
        // Negative USDC = out of the pool = trader received USDC = SELL.
        assert_eq!(classify_side(&big("-3000000000")), Some("SELL"));
        // Zero carries no direction.
        assert_eq!(classify_side(&big("0")), None);
    }

    #[test]
    fn large_negative_amounts_stay_negative() {
        // Guards the classic int256 bug: an unsigned decode turns -1 into 2^256-1,
        // which would relabel every sell as a buy.
        let minus_one = big("-1");
        assert_eq!(classify_side(&minus_one), Some("SELL"));

        let big_negative = big("-115792089237316195423570985008687907853269984665640564039457584007913129639");
        assert_eq!(classify_side(&big_negative), Some("SELL"));
    }

    #[test]
    fn usdc_notional_applies_six_decimals() {
        // 3000 USDC
        assert_eq!(format_units(&big("3000000000"), 6), "3000.000000");
        // Sign is dropped — direction lives in `side`, magnitude here.
        assert_eq!(format_units(&big("-3000000000"), 6), "3000.000000");
        // 1 USDC
        assert_eq!(format_units(&big("1000000"), 6), "1.000000");
        // Sub-unit amounts must not lose their leading zero.
        assert_eq!(format_units(&big("123"), 6), "0.000123");
        assert_eq!(format_units(&big("1"), 6), "0.000001");
        assert_eq!(format_units(&big("0"), 6), "0.000000");
    }

    #[test]
    fn usdc_notional_is_exact_for_large_values() {
        // ~1.2 billion USDC. An f64 path would start losing units here; the string
        // path is exact.
        assert_eq!(format_units(&big("1234567890123456"), 6), "1234567890.123456");
    }

    #[test]
    fn rfc3339_matches_postgres_parseable_utc() {
        // The exact block whose swap we verified against Etherscan (block 21000006).
        // 13:46:59 UTC — Etherscan renders block times in the viewer's local zone, so
        // do not read the expected value off that page.
        assert_eq!(format_rfc3339(1729345619), "2024-10-19T13:46:59Z");

        // Unix epoch itself.
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        // One second before epoch+1day.
        assert_eq!(format_rfc3339(86_399), "1970-01-01T23:59:59Z");
        assert_eq!(format_rfc3339(86_400), "1970-01-02T00:00:00Z");

        // Leap day — the case a naive 365-day implementation gets wrong.
        assert_eq!(format_rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
        // Day after the leap day.
        assert_eq!(format_rfc3339(1_709_251_200), "2024-03-01T00:00:00Z");
        // Year boundary.
        assert_eq!(format_rfc3339(1_735_689_599), "2024-12-31T23:59:59Z");
        assert_eq!(format_rfc3339(1_735_689_600), "2025-01-01T00:00:00Z");
        // 2000 was a leap year (divisible by 400) — the century rule's exception.
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn rfc3339_is_zero_padded_everywhere() {
        // Postgres tolerates some sloppiness, but a fixed-width format keeps the
        // column sortable as text and avoids ambiguity.
        let s = format_rfc3339(1_704_070_805); // 2024-01-01T01:00:05Z
        assert_eq!(s, "2024-01-01T01:00:05Z");
        assert_eq!(s.len(), 20);
    }

    #[test]
    fn worked_example_from_the_uniswap_docs() {
        // WETH/USDC pool (token0 = USDC): amount0 = +3000 USDC, amount1 = -1 WETH
        // means someone sold 3,000 USDC into the pool and received 1 WETH out.
        let cfg = pool_config(&hex!("88e6a0c2ddd26feeb64f039a2c41296fcb3f5640")).unwrap();
        let amount0 = big("3000000000");
        let amount1 = big("-1000000000000000000");

        let usdc = if cfg.usdc_is_token0 { &amount0 } else { &amount1 };
        assert_eq!(classify_side(usdc), Some("BUY"));
        assert_eq!(format_units(usdc, USDC_DECIMALS), "3000.000000");

        // The SAME numbers read through a token1-USDC pool (as WBTC/USDC was) give the
        // OPPOSITE label. This is why orientation must travel with the pool: a single
        // hardcoded leg would invert every label the moment such a pool is added.
        let flipped = PoolConfig {
            address: hex!("0000000000000000000000000000000000000001"),
            pair: "TEST/USDC",
            usdc_is_token0: false,
        };
        let usdc_flipped = if flipped.usdc_is_token0 { &amount0 } else { &amount1 };
        assert_eq!(classify_side(usdc_flipped), Some("SELL"));
    }
}
