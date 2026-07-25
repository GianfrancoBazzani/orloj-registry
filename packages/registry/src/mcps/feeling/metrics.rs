// Sentiment metric model.
//
// The whole "sentiment model" is four numbers derived from executed Uniswap V3 swaps,
// plus a label. There is deliberately no smoothing, no fitted parameter, and no
// prediction — see the module docs in mod.rs for why.
//
// Metric definitions (all over a time window W, per pair):
//   net_flow   = buy_vol - sell_vol                              [USDC]
//   imbalance  = (buy_vol - sell_vol) / (buy_vol + sell_vol)     [-1, +1]
//   trend      = imbalance(current W) - imbalance(previous W)
//   participation = swap_count + unique_senders
//
// `imbalance` is volume-weighted, so one whale outvotes the crowd. We therefore ALSO
// carry the count-weighted figure and surface both: when they diverge, that divergence
// is the interesting signal, not noise to average away.

use serde::Serialize;

/// Minimum number of swaps in a window before we are willing to print a label at all.
/// Below this, imbalance is unstable (two swaps can produce +1.0) and any label would
/// be false precision, so we return `InsufficientData` instead.
pub const PARTICIPATION_FLOOR: i64 = 10;

/// Default window if the caller does not specify one.
pub const DEFAULT_WINDOW_MINUTES: i64 = 15;

/// Bounds on the caller-supplied window, to keep one tool call from scanning everything.
pub const MIN_WINDOW_MINUTES: i64 = 1;
pub const MAX_WINDOW_MINUTES: i64 = 1440; // 24h

/// Sentiment labels.
///
/// Thresholds are round numbers chosen a priori and deliberately NOT fitted to data.
/// A threshold tuned on a few hours of observations would be overfitting dressed up as
/// a finding; these are readability aids for a continuous number that is always shown
/// alongside them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Sentiment {
    InsufficientData,
    BuyPressure,
    MildBuyPressure,
    Balanced,
    MildSellPressure,
    SellPressure,
}

impl Sentiment {
    pub fn as_str(&self) -> &'static str {
        match self {
            Sentiment::InsufficientData => "INSUFFICIENT_DATA",
            Sentiment::BuyPressure => "BUY_PRESSURE",
            Sentiment::MildBuyPressure => "MILD_BUY_PRESSURE",
            Sentiment::Balanced => "BALANCED",
            Sentiment::MildSellPressure => "MILD_SELL_PRESSURE",
            Sentiment::SellPressure => "SELL_PRESSURE",
        }
    }

    /// Classify a window.
    ///
    /// `imbalance` is `None` when the window is empty (SQL returns NULL rather than 0,
    /// so "no data" can never be mistaken for "balanced"). Both that case and a window
    /// below the participation floor collapse to `InsufficientData`.
    pub fn classify(imbalance: Option<f64>, swap_count: i64) -> Self {
        let Some(imb) = imbalance else {
            return Sentiment::InsufficientData;
        };
        if swap_count < PARTICIPATION_FLOOR {
            return Sentiment::InsufficientData;
        }
        if imb > 0.30 {
            Sentiment::BuyPressure
        } else if imb > 0.10 {
            Sentiment::MildBuyPressure
        } else if imb >= -0.10 {
            Sentiment::Balanced
        } else if imb >= -0.30 {
            Sentiment::MildSellPressure
        } else {
            Sentiment::SellPressure
        }
    }
}

/// One window's worth of flow, as read from Postgres.
///
/// Volumes are USDC (6dp applied upstream in the Substreams module). `imbalance` and
/// `trend` are `Option` because they are undefined on an empty window — that is a real
/// state, not an error, and it must not be coerced to 0.0.
#[derive(Debug, Clone, Serialize)]
pub struct SentimentSnapshot {
    pub pair: String,
    pub window_minutes: i64,

    // (1) net flow
    pub net_flow_usdc: f64,
    pub buy_volume_usdc: f64,
    pub sell_volume_usdc: f64,

    // (2) imbalance — volume-weighted, plus the count-weighted companion
    pub imbalance: Option<f64>,
    pub imbalance_by_count: Option<f64>,

    // (3) trend
    pub trend: Option<f64>,
    pub previous_imbalance: Option<f64>,

    // (4) participation
    pub swap_count: i64,
    pub buy_count: i64,
    pub sell_count: i64,
    pub unique_senders: i64,

    pub sentiment: Sentiment,

    /// Freshness of the underlying data. `None` when the window is empty.
    pub latest_block: Option<i64>,
    pub seconds_since_latest_swap: Option<i64>,
}

impl SentimentSnapshot {
    /// True when volume-weighted and count-weighted imbalance point in opposite
    /// directions, or differ by more than 0.25. That means a handful of large swaps are
    /// carrying the signal against the broader crowd — worth saying out loud rather
    /// than hiding behind a single number.
    pub fn whale_divergence(&self) -> bool {
        match (self.imbalance, self.imbalance_by_count) {
            (Some(vol), Some(cnt)) => {
                (vol > 0.0 && cnt < 0.0) || (vol < 0.0 && cnt > 0.0) || (vol - cnt).abs() > 0.25
            }
            _ => false,
        }
    }

    /// Plain-language explanation of the current reading.
    ///
    /// This is deliberately generated from the numbers rather than by a model: it is
    /// the same every time for the same input, cannot hallucinate a figure, and cannot
    /// be steered by anything on-chain. The LLM-facing tool wraps this, it does not
    /// replace it.
    pub fn explain(&self) -> String {
        if self.sentiment == Sentiment::InsufficientData {
            return format!(
                "INSUFFICIENT DATA for {pair}: only {n} swap(s) in the last {w} minutes \
                 (floor is {floor}). Imbalance over so few swaps is unstable — two trades \
                 can produce a reading of +1.0 — so no sentiment label is given. This is a \
                 statement about sample size, not about the market being quiet or balanced.",
                pair = self.pair,
                n = self.swap_count,
                w = self.window_minutes,
                floor = PARTICIPATION_FLOOR,
            );
        }

        // Safe: any None imbalance classified as InsufficientData above.
        let imb = self.imbalance.unwrap_or(0.0);
        // Capitalised because it opens a sentence in the prose below.
        let direction = if self.net_flow_usdc >= 0.0 { "Buying" } else { "Selling" };

        let mut s = format!(
            "Over the last {w} minutes, {pair} saw {buy} of buying against {sell} of selling \
             — a net flow of {net} and a volume-weighted imbalance of {imb:+.2} across {n} \
             swaps from {senders} distinct senders. {dir_sentence}",
            w = self.window_minutes,
            pair = self.pair,
            buy = fmt_usd(self.buy_volume_usdc),
            sell = fmt_usd(self.sell_volume_usdc),
            net = fmt_usd(self.net_flow_usdc),
            imb = imb,
            n = self.swap_count,
            senders = self.unique_senders,
            dir_sentence = match self.sentiment {
                Sentiment::BuyPressure => format!("{direction} is clearly dominant."),
                Sentiment::MildBuyPressure | Sentiment::MildSellPressure =>
                    format!("{direction} is moderately dominant."),
                Sentiment::Balanced => "Neither side is meaningfully dominant.".to_string(),
                Sentiment::SellPressure => format!("{direction} is clearly dominant."),
                Sentiment::InsufficientData => unreachable!(),
            },
        );

        if let Some(cnt) = self.imbalance_by_count {
            if self.whale_divergence() {
                s.push_str(&format!(
                    " Note the count-weighted imbalance is {cnt:+.2}, which diverges from the \
                     volume-weighted {imb:+.2}: a small number of larger swaps is doing most of \
                     the work, so this does not represent broad participation."
                ));
            } else {
                s.push_str(&format!(
                    " The count-weighted imbalance ({cnt:+.2}) agrees with the volume-weighted \
                     figure, so the reading is not driven by one or two outsized trades."
                ));
            }
        }

        match (self.trend, self.previous_imbalance) {
            (Some(t), Some(prev)) => {
                let word = if t > 0.05 {
                    "shifted toward buying"
                } else if t < -0.05 {
                    "shifted toward selling"
                } else {
                    "held roughly steady"
                };
                s.push_str(&format!(
                    " Versus the previous {w}-minute window (imbalance {prev:+.2}), sentiment has \
                     {word} ({t:+.2}).",
                    w = self.window_minutes,
                ));
            }
            _ => s.push_str(
                " There is no comparable previous window, so no trend is reported.",
            ),
        }

        s.push_str(&format!(
            "\n\nWhat would change this read: a single large router or arbitrage swap can move \
             the volume-weighted figure substantially at this participation level ({n} swaps); \
             a longer window, or the count-weighted figure, is the check. \
             {caveat}",
            n = self.swap_count,
            caveat = CAVEAT,
        ));

        s
    }
}

/// Aggregate a set of pulled swaps into a snapshot.
///
/// This is the pull-mode counterpart to the SQL window query: same four metrics, same
/// definitions, computed in-process over swaps fetched on demand instead of over rows
/// in a table.
///
/// `trend` needs a *previous* window, so callers that want it must pull twice the block
/// range and split it — see `SentimentSnapshot::from_split`. A single pull leaves trend
/// as `None`, which is honest: there is nothing to compare against.
pub fn aggregate<'a, I>(pair: &str, window_minutes: i64, swaps: I) -> SentimentSnapshot
where
    I: IntoIterator<Item = &'a crate::mcps::feeling::pull::PulledSwap>,
{
    let mut buy_vol = 0.0;
    let mut sell_vol = 0.0;
    let mut buy_count = 0i64;
    let mut sell_count = 0i64;
    let mut senders = std::collections::HashSet::new();
    let mut latest_block = 0u64;
    let mut latest_ts = 0u64;

    for s in swaps {
        if s.is_buy() {
            buy_vol += s.notional();
            buy_count += 1;
        } else {
            sell_vol += s.notional();
            sell_count += 1;
        }
        senders.insert(s.sender.clone());
        latest_block = latest_block.max(s.block());
        latest_ts = latest_ts.max(s.timestamp.parse().unwrap_or(0));
    }

    let swap_count = buy_count + sell_count;
    let total = buy_vol + sell_vol;

    // NULL-equivalent on an empty window: no data is not the same as "balanced".
    let imbalance = if total > 0.0 {
        Some((buy_vol - sell_vol) / total)
    } else {
        None
    };
    let imbalance_by_count = if swap_count > 0 {
        Some((buy_count - sell_count) as f64 / swap_count as f64)
    } else {
        None
    };

    // Age of the newest swap, from the block timestamp. Not wall-clock freshness of the
    // pull itself — a quiet market legitimately yields an old newest-swap.
    let seconds_since_latest_swap = if latest_ts > 0 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| (d.as_secs() as i64 - latest_ts as i64).max(0))
    } else {
        None
    };

    SentimentSnapshot {
        pair: pair.to_string(),
        window_minutes,
        net_flow_usdc: buy_vol - sell_vol,
        buy_volume_usdc: buy_vol,
        sell_volume_usdc: sell_vol,
        imbalance,
        imbalance_by_count,
        trend: None,
        previous_imbalance: None,
        swap_count,
        buy_count,
        sell_count,
        unique_senders: senders.len() as i64,
        sentiment: Sentiment::classify(imbalance, swap_count),
        latest_block: if latest_block > 0 {
            Some(latest_block as i64)
        } else {
            None
        },
        seconds_since_latest_swap,
    }
}

impl SentimentSnapshot {
    /// Build a snapshot with a trend, from swaps spanning two consecutive windows.
    ///
    /// `split_block` is the boundary: swaps at or above it are the current window,
    /// below it are the previous one. Trend is the change in imbalance between them.
    pub fn from_split(
        pair: &str,
        window_minutes: i64,
        all: &[crate::mcps::feeling::pull::PulledSwap],
        split_block: u64,
    ) -> Self {
        let (current, previous): (Vec<_>, Vec<_>) =
            all.iter().partition(|s| s.block() >= split_block);

        let mut snap = aggregate(pair, window_minutes, current);
        let prev = aggregate(pair, window_minutes, previous);

        snap.previous_imbalance = prev.imbalance;
        // Trend is only meaningful when BOTH windows have data.
        snap.trend = match (snap.imbalance, prev.imbalance) {
            (Some(now), Some(before)) => Some(now - before),
            _ => None,
        };
        snap
    }
}

/// Attached to every explanation. These are not fine print — they bound what the number
/// can honestly be used for, so they travel with it.
pub const CAVEAT: &str = "Caveats: this measures flow in ONE pool per pair, not the \
market. Pool flow is not trader intent — a multi-hop route through both pools appears \
as a sell in one and a buy in the other when the trader did neither. Router and \
arbitrage/MEV swaps are included and are NOT filtered; arbitrage is directionally \
meaningless by construction. `sender` is usually a router contract, so unique-sender \
counts are a lower bound on real participants. Data is confirmed, executed blocks only \
— Substreams cannot see the mempool — so this is descriptive, not predictive.";

/// Format a USDC amount for prose. Whole dollars; magnitude suffixes above 1M/1K.
fn fmt_usd(v: f64) -> String {
    let sign = if v < 0.0 { "-" } else { "" };
    let a = v.abs();
    if a >= 1_000_000.0 {
        format!("{sign}${:.2}M", a / 1_000_000.0)
    } else if a >= 1_000.0 {
        format!("{sign}${:.1}K", a / 1_000.0)
    } else {
        format!("{sign}${a:.0}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_window_is_insufficient_not_balanced() {
        // The critical case: SQL returns NULL imbalance for an empty window. It must
        // never be read as "balanced" (which is what a 0.0 default would produce).
        assert_eq!(Sentiment::classify(None, 0), Sentiment::InsufficientData);
        assert_eq!(Sentiment::classify(None, 999), Sentiment::InsufficientData);
    }

    #[test]
    fn below_floor_is_insufficient_even_at_extreme_imbalance() {
        // Two swaps producing +1.0 must not print BUY_PRESSURE.
        assert_eq!(Sentiment::classify(Some(1.0), 2), Sentiment::InsufficientData);
        assert_eq!(
            Sentiment::classify(Some(1.0), PARTICIPATION_FLOOR),
            Sentiment::BuyPressure
        );
    }

    #[test]
    fn thresholds_are_the_documented_ones() {
        let n = PARTICIPATION_FLOOR;
        assert_eq!(Sentiment::classify(Some(0.31), n), Sentiment::BuyPressure);
        assert_eq!(Sentiment::classify(Some(0.30), n), Sentiment::MildBuyPressure);
        assert_eq!(Sentiment::classify(Some(0.11), n), Sentiment::MildBuyPressure);
        assert_eq!(Sentiment::classify(Some(0.10), n), Sentiment::Balanced);
        assert_eq!(Sentiment::classify(Some(0.0), n), Sentiment::Balanced);
        assert_eq!(Sentiment::classify(Some(-0.10), n), Sentiment::Balanced);
        assert_eq!(Sentiment::classify(Some(-0.11), n), Sentiment::MildSellPressure);
        assert_eq!(Sentiment::classify(Some(-0.30), n), Sentiment::MildSellPressure);
        assert_eq!(Sentiment::classify(Some(-0.31), n), Sentiment::SellPressure);
    }

    fn snap(vol: Option<f64>, cnt: Option<f64>) -> SentimentSnapshot {
        SentimentSnapshot {
            pair: "WETH/USDC".into(),
            window_minutes: 15,
            net_flow_usdc: 500.0,
            buy_volume_usdc: 1000.0,
            sell_volume_usdc: 500.0,
            imbalance: vol,
            imbalance_by_count: cnt,
            trend: Some(1.1333),
            previous_imbalance: Some(-0.8),
            swap_count: 40,
            buy_count: 20,
            sell_count: 20,
            unique_senders: 3,
            sentiment: Sentiment::classify(vol, 40),
            latest_block: Some(21_000_000),
            seconds_since_latest_swap: Some(8),
        }
    }

    #[test]
    fn whale_divergence_detects_opposite_signs_and_wide_gaps() {
        // Volume says buy, count says sell → divergence.
        assert!(snap(Some(0.33), Some(-0.10)).whale_divergence());
        // Same sign but far apart → divergence (this is the verified fixture case:
        // volume +0.33 with count 0.00 means big buys, balanced trade count).
        assert!(snap(Some(0.33), Some(0.0)).whale_divergence());
        // Close agreement → no divergence.
        assert!(!snap(Some(0.33), Some(0.30)).whale_divergence());
    }

    #[test]
    fn explanation_states_sample_size_when_insufficient() {
        let mut s = snap(Some(1.0), Some(1.0));
        s.swap_count = 2;
        s.sentiment = Sentiment::classify(Some(1.0), 2);
        let text = s.explain();
        assert!(text.contains("INSUFFICIENT DATA"));
        assert!(text.contains("2 swap(s)"));
        // Must not imply a quiet/balanced market.
        assert!(!text.contains("BALANCED"));
    }

    #[test]
    fn explanation_always_carries_caveats_and_a_falsifier() {
        let text = snap(Some(0.33), Some(0.0)).explain();
        assert!(text.contains("What would change this read"));
        assert!(text.contains("not predictive"));
        assert!(text.contains("mempool"));
    }
}
