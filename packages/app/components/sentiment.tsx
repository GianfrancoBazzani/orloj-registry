"use client";
import { useCallback, useEffect, useState } from "react";
import { Pill, Btn, Divider, FramedCard, SectionHeader } from "./ornaments";

// Onchain market sentiment panel.
//
// Reads /api/sentiment, which proxies the bearer-authenticated `feeling` MCP so the
// token never reaches the browser. Each request is a LIVE chain read (a Substreams run
// over 2x the selected block count, for the trend window), so it takes several
// seconds and nothing here is cached.
//
// Two UI rules carry most of the credibility:
//   1. INSUFFICIENT_DATA never renders as a normal label. Below the participation floor
//      the card greys out and states the sample size, because showing "BALANCED" when
//      the truth is "we don't know" is the one failure that would discredit everything
//      else on screen.
//   2. Volume- and count-weighted imbalance are always shown together. When they
//      diverge, a few large swaps are outvoting the crowd — that divergence is the
//      interesting signal, not noise to average away.

const PAIRS = ["WETH/USDC"] as const;
type Pair = (typeof PAIRS)[number];

type Label =
  | "BUY_PRESSURE"
  | "MILD_BUY_PRESSURE"
  | "BALANCED"
  | "MILD_SELL_PRESSURE"
  | "SELL_PRESSURE"
  | "INSUFFICIENT_DATA";

interface RecentSwap {
  txHash: string;
  logIndex: number;
  side: "BUY" | "SELL";
  usdcNotional: number;
  sender: string;
  blockNumber: number;
}

interface Reading {
  pair: string;
  blocksAnalysed: number;
  fromBlock: number;
  toBlock: number;
  approxWindowMinutes: number;
  sentiment: Label;
  netFlowUsdc: number;
  buyVolumeUsdc: number;
  sellVolumeUsdc: number;
  imbalance: number | null;
  imbalanceByCount: number | null;
  trend: number | null;
  previousImbalance: number | null;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueSenders: number;
  participationFloor: number;
  whaleDivergence: boolean;
  fetchMs: number;
  caveats: string;
  explanation: string | null;
  recentSwaps: RecentSwap[] | null;
}

const LABEL_TEXT: Record<Label, string> = {
  BUY_PRESSURE: "Buy pressure",
  MILD_BUY_PRESSURE: "Mild buy pressure",
  BALANCED: "Balanced",
  MILD_SELL_PRESSURE: "Mild sell pressure",
  SELL_PRESSURE: "Sell pressure",
  INSUFFICIENT_DATA: "Insufficient data",
};

/** Sentiment maps onto the existing palette: verdigris = buying, wine = selling. */
const LABEL_TONE: Record<Label, string> = {
  BUY_PRESSURE: "verdigris",
  MILD_BUY_PRESSURE: "verdigris",
  BALANCED: "brass",
  MILD_SELL_PRESSURE: "wine",
  SELL_PRESSURE: "wine",
  INSUFFICIENT_DATA: "ink",
};

const LABEL_COLOR: Record<Label, string> = {
  BUY_PRESSURE: "var(--verdigris-deep)",
  MILD_BUY_PRESSURE: "var(--verdigris)",
  BALANCED: "var(--brass-deep)",
  MILD_SELL_PRESSURE: "var(--wine)",
  SELL_PRESSURE: "var(--wine)",
  INSUFFICIENT_DATA: "var(--ink)",
};

const usd = (v: number) => {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
};

const signed = (v: number | null, digits = 2) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

/** Imbalance rendered on a -1..+1 axis with zero marked. */
const ImbalanceBar = ({ value, tone }: { value: number | null; tone: string }) => {
  const pct = value === null ? 0 : ((value + 1) / 2) * 100;
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          position: "relative",
          height: 10,
          background: "rgba(0,0,0,0.06)",
          border: "1px solid var(--line)",
          borderRadius: 5,
        }}
      >
        {/* zero marker */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: -3,
            bottom: -3,
            width: 1,
            background: "var(--line)",
          }}
        />
        {value !== null && (
          <div
            style={{
              position: "absolute",
              left: `calc(${pct}% - 6px)`,
              top: -3,
              width: 12,
              height: 16,
              borderRadius: 3,
              background: tone,
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
              transition: "left 600ms ease",
            }}
          />
        )}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          opacity: 0.5,
          marginTop: 3,
        }}
      >
        <span>−1 all sells</span>
        <span>0</span>
        <span>+1 all buys</span>
      </div>
    </div>
  );
};

const Stat = ({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) => (
  <div>
    <div className="smallcaps" style={{ fontSize: 10, opacity: 0.6 }}>
      {label}
    </div>
    <div className="mono" style={{ fontSize: 16, color: color ?? "inherit" }}>
      {value}
    </div>
    {hint && (
      <div style={{ fontSize: 10, opacity: 0.55, marginTop: 1 }}>{hint}</div>
    )}
  </div>
);

const PairCard = ({
  pair,
  blocks,
  detail,
  /**
   * Staggers this card's first fetch. Each request opens Substreams streams upstream,
   * and the free plan caps concurrent streams — two cards firing at once get one killed
   * with "ResourceExhausted: Concurrent stream limit". Offsetting them avoids that
   * without any coordination between components.
   */
  startDelayMs = 0,
}: {
  pair: Pair;
  blocks: number;
  detail: boolean;
  startDelayMs?: number;
}) => {
  const [data, setData] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinguish "first load" from "refreshing": on refresh we keep the previous
  // numbers on screen rather than blanking a card for 5 seconds.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/sentiment?pair=${encodeURIComponent(pair)}&blocks=${blocks}${
          detail ? "&detail=full" : ""
        }`,
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `request failed (${res.status})`);
      } else {
        setData(body);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pair, blocks, detail]);

  useEffect(() => {
    // 30s, not 5s: every poll is a real mainnet fetch, and a 500-block window barely
    // moves in five seconds. The initial offset keeps the two cards from competing for
    // the upstream concurrent-stream budget.
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      load();
      interval = setInterval(load, 30_000);
    }, startDelayMs);
    return () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }, [load, startDelayMs]);

  const insufficient = data?.sentiment === "INSUFFICIENT_DATA";
  const tone = data ? LABEL_TONE[data.sentiment] : "ink";
  const color = data ? LABEL_COLOR[data.sentiment] : "var(--ink)";

  return (
    <FramedCard padding={22}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <div className="display" style={{ fontSize: 19 }}>
          {pair}
        </div>
        <Pill tone={tone}>
          {data ? LABEL_TEXT[data.sentiment] : loading ? "loading…" : "—"}
        </Pill>
      </div>

      <div className="mono" style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
        Uniswap V3 · {pair === "WETH/USDC" ? "0.05%" : "0.30%"} ·{" "}
        {data ? `blocks ${data.fromBlock}–${data.toBlock}` : `last ${blocks} blocks`}
      </div>

      <Divider className="my-3" />

      {error && (
        <div
          style={{
            padding: 12,
            border: "1px solid rgba(138,53,38,0.35)",
            background: "rgba(138,53,38,0.08)",
            color: "var(--wine)",
            fontSize: 12,
          }}
        >
          <strong>Could not read sentiment.</strong>
          <div className="mono" style={{ marginTop: 4, fontSize: 11 }}>
            {error}
          </div>
        </div>
      )}

      {!error && !data && (
        <div style={{ padding: "26px 0", textAlign: "center", opacity: 0.55 }}>
          <div className="poetic" style={{ fontSize: 14 }}>
            reading the last {blocks} blocks…
          </div>
          <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>
            live chain fetch, usually 3–7s
          </div>
        </div>
      )}

      {!error && data && insufficient && (
        // Never show a label off too few swaps: two trades can produce +1.0.
        <div
          style={{
            padding: 14,
            border: "1px dashed var(--line)",
            background: "rgba(0,0,0,0.03)",
          }}
        >
          <div className="display" style={{ fontSize: 15, opacity: 0.7 }}>
            Insufficient data
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 5, lineHeight: 1.5 }}>
            Only <strong>{data.swapCount}</strong> swap
            {data.swapCount === 1 ? "" : "s"} in the last {data.blocksAnalysed} blocks
            (floor is {data.participationFloor}). Imbalance over so few swaps is
            unstable, so no label is shown. This is a statement about sample size — not
            a quiet or balanced market.
          </div>
        </div>
      )}

      {!error && data && !insufficient && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className="display" style={{ fontSize: 30, color }}>
              {signed(data.imbalance)}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              volume-weighted imbalance
            </div>
          </div>

          <ImbalanceBar value={data.imbalance} tone={color} />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
              marginTop: 16,
            }}
          >
            <Stat
              label="net flow"
              value={usd(data.netFlowUsdc)}
              color={color}
              hint={`over ~${data.approxWindowMinutes} min`}
            />
            <Stat
              label="by count"
              value={signed(data.imbalanceByCount)}
              hint={
                data.whaleDivergence ? "diverges from volume" : "agrees with volume"
              }
              color={data.whaleDivergence ? "var(--brass-deep)" : undefined}
            />
            <Stat
              label="buys"
              value={usd(data.buyVolumeUsdc)}
              hint={`${data.buyCount} swaps`}
            />
            <Stat
              label="sells"
              value={usd(data.sellVolumeUsdc)}
              hint={`${data.sellCount} swaps`}
            />
            <Stat
              label="trend"
              value={signed(data.trend)}
              hint={
                data.previousImbalance === null
                  ? "no previous window"
                  : `prev ${signed(data.previousImbalance)}`
              }
            />
            <Stat
              label="participation"
              value={`${data.swapCount} / ${data.uniqueSenders}`}
              hint="swaps / senders"
            />
          </div>

          {data.whaleDivergence && (
            <div
              style={{
                marginTop: 13,
                padding: "8px 11px",
                background: "rgba(184,137,58,0.10)",
                border: "1px solid rgba(184,137,58,0.35)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              A few larger swaps are carrying this reading — the count-weighted figure
              disagrees with the volume-weighted one, so it does not represent broad
              participation.
            </div>
          )}
        </>
      )}

      {/* The insufficient-data card already states the sample size in full, so the
          prose would just repeat it. Only show the explanation alongside a real
          reading. */}
      {detail && data?.explanation && !insufficient && (
        <>
          <Divider className="my-3" />
          <div style={{ fontSize: 12, lineHeight: 1.65, opacity: 0.85 }}>
            {data.explanation.split("Caveats:")[0].trim()}
          </div>
        </>
      )}

      {detail && data?.recentSwaps && data.recentSwaps.length > 0 && (
        <>
          <Divider className="my-3" />
          <div className="smallcaps" style={{ fontSize: 10, opacity: 0.6 }}>
            receipts — click through to verify
          </div>
          <div style={{ marginTop: 7 }}>
            {data.recentSwaps.slice(0, 6).map((s) => (
              <a
                key={`${s.txHash}-${s.logIndex}`}
                href={`https://etherscan.io/tx/0x${s.txHash.replace(/^0x/, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mono"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  padding: "3px 0",
                  borderBottom: "1px solid rgba(0,0,0,0.05)",
                  color: "inherit",
                  textDecoration: "none",
                }}
              >
                <span
                  style={{
                    color:
                      s.side === "BUY" ? "var(--verdigris-deep)" : "var(--wine)",
                    minWidth: 34,
                  }}
                >
                  {s.side}
                </span>
                <span style={{ flex: 1 }}>${s.usdcNotional.toLocaleString()}</span>
                <span style={{ opacity: 0.5 }}>
                  {s.txHash.replace(/^0x/, "").slice(0, 10)}…
                </span>
              </a>
            ))}
          </div>
        </>
      )}

      <div
        className="mono"
        style={{
          marginTop: 12,
          fontSize: 10,
          opacity: 0.45,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{loading ? "updating…" : data ? `fetched in ${data.fetchMs}ms` : ""}</span>
        <span>auto-refresh 30s</span>
      </div>
    </FramedCard>
  );
};

export const Sentiment = () => {
  const [blocks, setBlocks] = useState(500);
  const [detail, setDetail] = useState(true);

  return (
    <section style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 20px 60px" }}>
      <SectionHeader
        eyebrow="onchain market sentiment"
        title="What the flow is actually doing"
        subtitle="Buy vs sell pressure derived from executed Uniswap V3 swaps. Each reading is computed on demand from recent mainnet blocks — nothing is cached."
      />

      <div style={{ display: "flex", gap: 8, margin: "18px 0 20px", flexWrap: "wrap" }}>
        {[500, 1000, 2000].map((b) => (
          <Btn
            key={b}
            kind={b === blocks ? "primary" : "ghost"}
            size="sm"
            onClick={() => setBlocks(b)}
          >
            {b} blocks
          </Btn>
        ))}
        <Btn kind={detail ? "primary" : "ghost"} size="sm" onClick={() => setDetail(!detail)}>
          {detail ? "hide detail" : "show detail"}
        </Btn>
      </div>

      <div
        style={{
          display: "grid",
          // Single pair: one readable column rather than a half-width card
          // marooned beside empty space. Revert to auto-fit when a second pair returns.
          gridTemplateColumns: "minmax(330px, 620px)",
          justifyContent: "center",
          // Cards size to their own content: a quiet pair showing INSUFFICIENT_DATA
          // should not be stretched to match a busy one's explanation + receipts.
          alignItems: "start",
          gap: 20,
        }}
      >
        {PAIRS.map((p, i) => (
          <PairCard
            key={p}
            pair={p}
            blocks={blocks}
            detail={detail}
            // No-op with a single pair; kept so re-adding a pair cannot
            // reintroduce the upstream concurrent-stream collision.
            startDelayMs={i * 20_000}
          />
        ))}
      </div>

      {/* Persistent, not collapsible. These bound what the number can honestly be
          used for, so they stay on screen with it. */}
      <div
        style={{
          marginTop: 24,
          padding: 14,
          border: "1px solid var(--line)",
          background: "rgba(0,0,0,0.02)",
          fontSize: 11,
          lineHeight: 1.65,
          opacity: 0.75,
        }}
      >
        <strong className="smallcaps" style={{ fontSize: 10 }}>
          how to read this
        </strong>
        <div style={{ marginTop: 5 }}>
          This measures flow in <strong>one pool per pair</strong>, not the market. Pool
          flow is not trader intent — a multi-hop route appears as a sell in one pool
          and a buy in another when the trader did neither. Router and arbitrage/MEV
          swaps are included and <strong>not filtered</strong>; arbitrage is
          directionally meaningless by construction. Sender addresses are usually router
          contracts, so sender counts are a lower bound on real participants. Substreams
          reads executed blocks and cannot see the mempool, so this is{" "}
          <strong>descriptive, never predictive</strong> — it is not a trade signal.
        </div>
      </div>
    </section>
  );
};
