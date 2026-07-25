import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractFeatures,
  isInRange,
  assessUsdDataUsable,
  MIN_TICK_SAMPLES_6H,
  MIN_TICK_SAMPLES_24H,
  SUSPICIOUS_TVL_USD,
} from "../src/features.mjs";
import { DEFAULT_SUBGRAPH_ID } from "../src/config.mjs";

const NOW = 1_700_000_000;
const POOL = "0xabcdef0123456789abcdef0123456789abcdef01";
const T0 = "0x0000000000000000000000000000000000000001";
const T1 = "0x0000000000000000000000000000000000000002";

function basePosition(overrides = {}) {
  return {
    chainId: "11155111",
    walletAddress: "0x1111111111111111111111111111111111111111",
    nftTokenId: "42",
    poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    token0: T0,
    token1: T1,
    fee: "3000",
    tickLower: "-100",
    tickUpper: "100",
    liquidity: "1000",
    tokensOwed0: "0",
    tokensOwed1: "0",
    ...overrides,
  };
}

function hour(periodStartUnix, overrides = {}) {
  return {
    id: `${POOL}-${periodStartUnix}`,
    periodStartUnix: String(periodStartUnix),
    tick: "0",
    liquidity: "1000",
    sqrtPrice: "1",
    tvlUSD: "100",
    volumeUSD: "10",
    volumeToken0: "1",
    volumeToken1: "2",
    feesUSD: "0.1",
    txCount: "5",
    ...overrides,
  };
}

function baseMarket(overrides = {}) {
  const {
    pool: poolOver = {},
    hourData,
    swaps,
    swapWindow = {},
    meta: metaOver = {},
    ...rest
  } = overrides;

  const hours =
    hourData ??
    [
      hour(NOW - 3600, {
        tick: "10",
        txCount: "2",
        volumeToken0: "1",
        volumeToken1: "1",
        volumeUSD: "5",
        feesUSD: "0.05",
        tvlUSD: "100",
        liquidity: "1000",
      }),
      hour(NOW - 7200, {
        tick: "0",
        txCount: "3",
        volumeToken0: "1",
        volumeToken1: "1",
        volumeUSD: "5",
        feesUSD: "0.05",
        tvlUSD: "100",
        liquidity: "900",
      }),
      hour(NOW - 10800, {
        tick: "-5",
        txCount: "1",
        volumeToken0: "1",
        volumeToken1: "1",
        volumeUSD: "5",
        feesUSD: "0.05",
        tvlUSD: "100",
        liquidity: "800",
      }),
    ];

  return {
    subgraphId: DEFAULT_SUBGRAPH_ID,
    poolId: POOL,
    queriedAt: NOW,
    meta: {
      blockNumber: "100",
      blockHash: "0xabc",
      blockTimestamp: String(NOW - 30),
      hasIndexingErrors: false,
      ageSeconds: 30,
      maxIndexedAgeSeconds: 3600,
      ...metaOver,
    },
    pool: {
      id: POOL,
      tick: "0",
      sqrtPrice: "1",
      liquidity: "1000",
      feeTier: "3000",
      totalValueLockedUSD: "100",
      totalValueLockedToken0: "1",
      totalValueLockedToken1: "2",
      volumeUSD: "100",
      volumeToken0: "10",
      volumeToken1: "20",
      feesUSD: "1",
      token0: { id: T0, symbol: "A", decimals: "18" },
      token1: { id: T1, symbol: "B", decimals: "6" },
      ...poolOver,
    },
    hourData: hours,
    swaps: swaps ?? [],
    windows: {
      hour: {
        startUnix: NOW - 48 * 3600,
        endUnix: NOW,
        boundBy: "periodStartUnix",
        rowCount: hours.length,
      },
      swap: {
        startUnix: NOW - 24 * 3600,
        endUnix: NOW,
        boundBy: "timestamp",
        rowCount: (swaps ?? []).length,
        fetchedCount: (swaps ?? []).length,
        limit: 50,
        truncated: false,
        complete: true,
        ...swapWindow,
      },
    },
    inactivity: {
      noHourRows: hours.length === 0,
      noSwapRows: (swaps ?? []).length === 0,
    },
    ...rest,
  };
}

describe("features", () => {
  it("treats upper bound as exclusive for in-range", () => {
    assert.equal(isInRange(99, -100, 100), true);
    assert.equal(isInRange(100, -100, 100), false);
    assert.equal(isInRange(-100, -100, 100), true);
    assert.equal(isInRange(-101, -100, 100), false);
  });

  it("classifies in-range, below-range, and above-range positions", () => {
    const inRange = extractFeatures(basePosition(), baseMarket());
    assert.equal(inRange.range.status, "in_range");
    assert.equal(inRange.range.inRange, true);
    assert.equal(inRange.range.width, 200);
    assert.equal(inRange.range.distanceToLower, 100);
    assert.equal(inRange.range.distanceToUpper, 100);
    assert.equal(inRange.range.normalizedRangePosition, 0.5);

    const below = extractFeatures(
      basePosition(),
      baseMarket({
        pool: { tick: "-150" },
        hourData: [
          hour(NOW - 3600, {
            tick: "-150",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
          hour(NOW - 7200, {
            tick: "-140",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
          hour(NOW - 10800, {
            tick: "-130",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
        ],
      }),
    );
    assert.equal(below.range.status, "below_range");
    assert.equal(below.range.inRange, false);

    const above = extractFeatures(
      basePosition(),
      baseMarket({
        pool: { tick: "100" },
        hourData: [
          hour(NOW - 3600, {
            tick: "100",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
          hour(NOW - 7200, {
            tick: "110",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
          hour(NOW - 10800, {
            tick: "120",
            txCount: "1",
            volumeUSD: "1",
            volumeToken0: "1",
            volumeToken1: "1",
            feesUSD: "0.01",
            tvlUSD: "50",
          }),
        ],
      }),
    );
    assert.equal(above.range.status, "above_range");
    assert.equal(above.range.inRange, false);
    assert.equal(above.range.distanceToUpper, 0);
  });

  it("uses timestamp windows and never treats sparse ticks as zero volatility", () => {
    const sparseHours = [
      hour(NOW - 3600, {
        tick: "10",
        txCount: "4",
        volumeUSD: "1",
        volumeToken0: "1",
        volumeToken1: "1",
        feesUSD: "0.01",
        tvlUSD: "50",
      }),
    ];
    const f = extractFeatures(basePosition(), baseMarket({ hourData: sparseHours }));
    assert.equal(f.windows.h6.observationCount, 1);
    assert.equal(f.volatility.tickProxy6h.sampleCount, 1);
    assert.equal(f.volatility.tickProxy6h.sufficient, false);
    assert.equal(f.volatility.tickProxy6h.tickMovement.value, null);
    assert.match(
      f.volatility.tickProxy6h.tickMovement.reason,
      /insufficient_tick_samples/,
    );
    assert.ok(
      f.missingInputFlags.includes("insufficient_volatility_samples_6h"),
    );
    assert.equal(f.activity.txCountSum6h.value, 4);
  });

  it("empty fresh windows establish zero activity but not zero volatility", () => {
    const f = extractFeatures(basePosition(), baseMarket({ hourData: [] }));
    assert.equal(f.activity.txCountSum6h.value, 0);
    assert.equal(f.activity.txCountSum24h.value, 0);
    assert.equal(f.volatility.tickProxy6h.tickMovement.value, null);
    assert.match(
      f.volatility.tickProxy6h.tickMovement.reason,
      /empty_6h_window_cannot_infer_volatility/,
    );
    assert.equal(f.volumes.token0_6h.value, 0);
    assert.equal(f.volumes.token1_6h.value, 0);
  });

  it("sums hour txCount for activity and ignores sampled swap counts", () => {
    const hours = [];
    for (let i = 0; i < MIN_TICK_SAMPLES_6H; i++) {
      hours.push(
        hour(NOW - (i + 1) * 3600, {
          tick: String(i * 2),
          txCount: "10",
          volumeUSD: "1",
          volumeToken0: "1",
          volumeToken1: "2",
          feesUSD: "0.01",
          tvlUSD: "50",
        }),
      );
    }
    const f = extractFeatures(
      basePosition(),
      baseMarket({
        hourData: hours,
        swaps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
        swapWindow: {
          rowCount: 3,
          fetchedCount: 3,
          truncated: false,
          complete: true,
        },
      }),
    );
    assert.equal(f.activity.txCountSum6h.value, 10 * MIN_TICK_SAMPLES_6H);
    assert.notEqual(f.activity.txCountSum6h.value, 3);
    assert.match(f.activity.note, /txCount/);
  });

  it("preserves truncated swap-sample metadata without using it as intensity", () => {
    const f = extractFeatures(
      basePosition(),
      baseMarket({
        swapWindow: {
          truncated: true,
          complete: false,
          rowCount: 50,
          fetchedCount: 51,
          limit: 50,
        },
      }),
    );
    assert.equal(f.graph.swapSample.truncated, true);
    assert.equal(f.graph.swapSample.complete, false);
    assert.ok(f.missingInputFlags.includes("swap_sample_truncated"));
  });

  it("gates USD-derived features when Sepolia USD data is unreliable", () => {
    const bad = assessUsdDataUsable(
      {
        volumeToken0: "10",
        volumeToken1: "10",
        volumeUSD: "0",
        totalValueLockedUSD: String(SUSPICIOUS_TVL_USD),
        feesUSD: "1",
      },
      [],
    );
    assert.equal(bad.usable, false);
    assert.ok(bad.reasons.length >= 1);

    const f = extractFeatures(
      basePosition(),
      baseMarket({
        pool: {
          volumeUSD: "0",
          volumeToken0: "100",
          volumeToken1: "100",
          totalValueLockedUSD: String(SUSPICIOUS_TVL_USD * 2),
          feesUSD: "1",
        },
        hourData: [
          hour(NOW - 3600, {
            tick: "1",
            txCount: "1",
            volumeUSD: "0",
            volumeToken0: "5",
            volumeToken1: "5",
            feesUSD: "1",
            tvlUSD: String(SUSPICIOUS_TVL_USD),
          }),
          hour(NOW - 7200, {
            tick: "2",
            txCount: "1",
            volumeUSD: "0",
            volumeToken0: "5",
            volumeToken1: "5",
            feesUSD: "1",
            tvlUSD: String(SUSPICIOUS_TVL_USD),
          }),
          hour(NOW - 10800, {
            tick: "3",
            txCount: "1",
            volumeUSD: "0",
            volumeToken0: "5",
            volumeToken1: "5",
            feesUSD: "1",
            tvlUSD: String(SUSPICIOUS_TVL_USD),
          }),
        ],
      }),
    );
    assert.equal(f.usdDataUsable.usable, false);
    assert.equal(f.fees.feeToTvl_24h.value, null);
    assert.equal(f.fees.trend_6hVsPrev6h.value, null);
    assert.equal(f.tvl.trend_24h.value, null);
    assert.equal(f.volumes.token0_6h.value, 15);
    assert.equal(f.volumes.token1_6h.value, 15);
  });

  it("fails closed on cross-source pool/token/fee/chain mismatches", () => {
    assert.throws(
      () =>
        extractFeatures(
          basePosition({
            poolAddress: "0x00000000000000000000000000000000000000aa",
          }),
          baseMarket(),
        ),
      /pool address/,
    );
    assert.throws(
      () =>
        extractFeatures(
          basePosition({
            token0: "0x00000000000000000000000000000000000000aa",
          }),
          baseMarket(),
        ),
      /token pair/,
    );
    assert.throws(
      () => extractFeatures(basePosition({ fee: "500" }), baseMarket()),
      /fee tier/,
    );
    assert.throws(
      () => extractFeatures(basePosition({ chainId: "1" }), baseMarket()),
      /chainId/,
    );
    assert.throws(
      () =>
        extractFeatures(basePosition(), baseMarket(), {
          expectedNftTokenId: "99",
        }),
      /nftTokenId/,
    );
  });

  it("marks 24h volatility insufficient below the documented sample minimum", () => {
    const hours = [];
    for (let i = 0; i < MIN_TICK_SAMPLES_24H - 1; i++) {
      hours.push(
        hour(NOW - (i + 1) * 3600, {
          tick: String(i),
          txCount: "1",
          volumeUSD: "1",
          volumeToken0: "1",
          volumeToken1: "1",
          feesUSD: "0.01",
          tvlUSD: "50",
        }),
      );
    }
    const f = extractFeatures(basePosition(), baseMarket({ hourData: hours }));
    assert.equal(f.volatility.tickProxy24h.sufficient, false);
    assert.equal(f.volatility.tickProxy24h.tickMovement.value, null);
    assert.ok(
      f.missingInputFlags.includes("insufficient_volatility_samples_24h"),
    );
  });

  it("computes sufficient tick proxies and keeps token volumes separate", () => {
    const hours = [];
    // 6 observations across 24h (every 4h) for 24h vol minimum
    for (let i = 0; i < MIN_TICK_SAMPLES_24H; i++) {
      hours.push(
        hour(NOW - (i + 1) * 4 * 3600, {
          tick: String(i * 10),
          txCount: "2",
          volumeUSD: "1",
          volumeToken0: "3",
          volumeToken1: "7",
          feesUSD: "0.1",
          tvlUSD: "100",
          liquidity: String(1000 + i),
        }),
      );
    }
    // Extra dense samples in the last 6h so 6h vol is sufficient
    for (let i = 0; i < MIN_TICK_SAMPLES_6H; i++) {
      hours.push(
        hour(NOW - (i + 1) * 1800, {
          tick: String(50 + i),
          txCount: "1",
          volumeUSD: "1",
          volumeToken0: "3",
          volumeToken1: "7",
          feesUSD: "0.05",
          tvlUSD: "100",
          liquidity: "1000",
        }),
      );
    }

    const f = extractFeatures(basePosition(), baseMarket({ hourData: hours }));
    assert.equal(f.volatility.tickProxy24h.sufficient, true);
    assert.equal(f.volatility.tickProxy6h.sufficient, true);
    assert.notEqual(f.volatility.tickProxy24h.tickMovement.value, null);
    assert.equal(f.volumes.token0_6h.value, f.volumes.token1_6h.value * (3 / 7));
    assert.equal(f.volumes.token0_6h.value / 3, f.volumes.token1_6h.value / 7);
    assert.notEqual(f.volumes.token0_6h.value, f.volumes.token1_6h.value);
    assert.match(f.volumes.note, /never added/);
  });
});
