/**
 * Deterministic market / position feature extraction.
 * Pure / zero-dependency: no network, AI, or MCP calls.
 *
 * Design: missing or insufficient evidence → `{ value: null, reason }` — never a
 * fabricated 0 that could be mistaken for measured inactivity (except where an
 * empty fresh window explicitly establishes zero *activity*).
 */

import { DEFAULT_CHAIN_ID, toSubgraphPoolId } from "./config.mjs";

export const WINDOW_6H_SECONDS = 6 * 60 * 60;
export const WINDOW_24H_SECONDS = 24 * 60 * 60;

/** Minimum hour rows with tick for a 6h volatility proxy. */
export const MIN_TICK_SAMPLES_6H = 3;
/** Minimum hour rows with tick for a 24h volatility proxy. */
export const MIN_TICK_SAMPLES_24H = 6;

/** Sepolia USD values at/above this TVL are treated as suspicious. */
export const SUSPICIOUS_TVL_USD = 1e9;

/**
 * @typedef {{ value: null, reason: string }} NullFeature
 * @typedef {{ value: number, reason?: undefined }} NumberFeature
 * @typedef {NullFeature | NumberFeature} MaybeNumber
 */

/**
 * @param {string} reason
 * @returns {NullFeature}
 */
export function nullFeature(reason) {
  return { value: null, reason };
}

/**
 * @param {number} value
 * @returns {NumberFeature}
 */
export function numberFeature(value) {
  return { value };
}

/**
 * Uniswap V3: in range iff tickLower <= tick < tickUpper (upper exclusive).
 * @param {number} tick
 * @param {number} tickLower
 * @param {number} tickUpper
 */
export function isInRange(tick, tickLower, tickUpper) {
  return tickLower <= tick && tick < tickUpper;
}

/**
 * @param {import("./orloj-mcp-client.mjs").V3Position} position
 * @param {object} market normalized Graph market context
 * @param {{ expectedNftTokenId?: string }} [opts]
 */
export function extractFeatures(position, market, opts = {}) {
  if (!position || typeof position !== "object") {
    throw new Error("extractFeatures requires a validated Orloj position");
  }
  if (!market || typeof market !== "object") {
    throw new Error("extractFeatures requires normalized Graph market context");
  }

  assertCrossSourceAgreement(position, market, opts);

  const tickLower = parseIntTick(position.tickLower, "position.tickLower");
  const tickUpper = parseIntTick(position.tickUpper, "position.tickUpper");
  if (tickLower >= tickUpper) {
    throw new Error(
      `position tickLower (${tickLower}) must be < tickUpper (${tickUpper})`,
    );
  }

  const currentTick = parseIntTick(market.pool.tick, "market.pool.tick");
  const rangeWidth = tickUpper - tickLower;
  const distanceToLower = currentTick - tickLower;
  const distanceToUpper = tickUpper - currentTick;
  const absLower = Math.abs(distanceToLower);
  const absUpper = Math.abs(distanceToUpper);
  const nearestBoundaryDistance =
    absLower <= absUpper ? distanceToLower : distanceToUpper;
  const normalizedRangePosition = distanceToLower / rangeWidth;

  const inRange = isInRange(currentTick, tickLower, tickUpper);
  const rangeStatus = inRange
    ? "in_range"
    : currentTick < tickLower
      ? "below_range"
      : "above_range";

  const now = market.queriedAt;
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new Error("market.queriedAt must be a unix seconds number");
  }

  const hours = Array.isArray(market.hourData) ? market.hourData : [];
  const hours6h = filterHours(hours, now - WINDOW_6H_SECONDS, now);
  const hours24h = filterHours(hours, now - WINDOW_24H_SECONDS, now);
  const hoursPrev6h = filterHours(
    hours,
    now - 2 * WINDOW_6H_SECONDS,
    now - WINDOW_6H_SECONDS,
  );

  const usd = assessUsdDataUsable(market.pool, hours24h);

  const vol6h = tickVolatilityProxy(hours6h, MIN_TICK_SAMPLES_6H, "6h");
  const vol24h = tickVolatilityProxy(hours24h, MIN_TICK_SAMPLES_24H, "24h");

  const activity6h = activityFromTxCount(hours6h, "6h");
  const activity24h = activityFromTxCount(hours24h, "24h");

  const volumeToken0_6h = sumTokenField(hours6h, "volumeToken0", "6h");
  const volumeToken1_6h = sumTokenField(hours6h, "volumeToken1", "6h");
  const volumeToken0_24h = sumTokenField(hours24h, "volumeToken0", "24h");
  const volumeToken1_24h = sumTokenField(hours24h, "volumeToken1", "24h");
  const volumeToken0_prev6h = sumTokenField(hoursPrev6h, "volumeToken0", "prev6h");
  const volumeToken1_prev6h = sumTokenField(hoursPrev6h, "volumeToken1", "prev6h");

  const volumeTrendToken0_6h = ratioTrend(
    volumeToken0_6h,
    volumeToken0_prev6h,
    "volumeToken0",
  );
  const volumeTrendToken1_6h = ratioTrend(
    volumeToken1_6h,
    volumeToken1_prev6h,
    "volumeToken1",
  );

  const feesUsd_6h = usd.usable
    ? sumTokenField(hours6h, "feesUSD", "6h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");
  const feesUsd_prev6h = usd.usable
    ? sumTokenField(hoursPrev6h, "feesUSD", "prev6h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");
  const feesUsd_24h = usd.usable
    ? sumTokenField(hours24h, "feesUSD", "24h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const feeTrend_6h = usd.usable
    ? ratioTrend(feesUsd_6h, feesUsd_prev6h, "feesUSD")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const feeToTvl24h = feeToTvlProxy(feesUsd_24h, hours24h, usd);

  const liquidityTrend24h = liquidityTrend(hours24h, market.pool.liquidity);
  const tvlTrend24h = usd.usable
    ? tvlTrend(hours24h)
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const missingInputFlags = collectMissingFlags({
    hours6h,
    hours24h,
    hoursPrev6h,
    usd,
    vol6h,
    vol24h,
    market,
  });

  return {
    position: {
      nftTokenId: position.nftTokenId,
      chainId: position.chainId,
      poolAddress: toSubgraphPoolId(position.poolAddress),
      tickLower,
      tickUpper,
      liquidity: position.liquidity,
      fee: position.fee,
      token0: position.token0.toLowerCase(),
      token1: position.token1.toLowerCase(),
    },
    range: {
      currentTick,
      status: rangeStatus,
      inRange,
      width: rangeWidth,
      distanceToLower,
      distanceToUpper,
      nearestBoundaryDistance,
      normalizedRangePosition,
    },
    windows: {
      nowUnix: now,
      h6: windowMeta(hours6h, now - WINDOW_6H_SECONDS, now),
      h24: windowMeta(hours24h, now - WINDOW_24H_SECONDS, now),
      prev6h: windowMeta(
        hoursPrev6h,
        now - 2 * WINDOW_6H_SECONDS,
        now - WINDOW_6H_SECONDS,
      ),
    },
    volatility: {
      tickProxy6h: vol6h,
      tickProxy24h: vol24h,
    },
    activity: {
      txCountSum6h: activity6h,
      txCountSum24h: activity24h,
      note: "Activity uses summed PoolHourData.txCount; not sampled swap row counts",
    },
    volumes: {
      token0_6h: volumeToken0_6h,
      token1_6h: volumeToken1_6h,
      token0_24h: volumeToken0_24h,
      token1_24h: volumeToken1_24h,
      token0_prev6h: volumeToken0_prev6h,
      token1_prev6h: volumeToken1_prev6h,
      trendToken0_6hVsPrev6h: volumeTrendToken0_6h,
      trendToken1_6hVsPrev6h: volumeTrendToken1_6h,
      note: "token0 and token1 volumes are never added together",
    },
    fees: {
      usd_6h: feesUsd_6h,
      usd_prev6h: feesUsd_prev6h,
      usd_24h: feesUsd_24h,
      trend_6hVsPrev6h: feeTrend_6h,
      feeToTvl_24h: feeToTvl24h,
    },
    liquidity: {
      poolLiquidity: position.liquidity,
      trend_24h: liquidityTrend24h,
    },
    tvl: {
      trend_24h: tvlTrend24h,
    },
    usdDataUsable: usd,
    graph: {
      subgraphId: market.subgraphId,
      indexedBlock: market.meta?.blockNumber,
      indexedTimestamp: market.meta?.blockTimestamp,
      ageSeconds: market.meta?.ageSeconds,
      maxIndexedAgeSeconds: market.meta?.maxIndexedAgeSeconds,
      swapSample: {
        truncated: market.windows?.swap?.truncated === true,
        complete: market.windows?.swap?.complete === true,
        rowCount: market.windows?.swap?.rowCount,
        fetchedCount: market.windows?.swap?.fetchedCount,
        limit: market.windows?.swap?.limit,
      },
    },
    missingInputFlags,
    evidence: {
      hourRowsTotal: hours.length,
      hourRows6h: hours6h.length,
      hourRows24h: hours24h.length,
      hourRowsPrev6h: hoursPrev6h.length,
      swapRowsSampled: Array.isArray(market.swaps) ? market.swaps.length : 0,
    },
  };
}

/**
 * @param {object} position
 * @param {object} market
 * @param {{ expectedNftTokenId?: string }} opts
 */
function assertCrossSourceAgreement(position, market, opts) {
  if (position.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `cross-source mismatch: position.chainId ${position.chainId} !== ${DEFAULT_CHAIN_ID}`,
    );
  }
  if (opts.expectedNftTokenId !== undefined &&
      opts.expectedNftTokenId !== position.nftTokenId) {
    throw new Error(
      `cross-source mismatch: nftTokenId ${position.nftTokenId} !== expected ${opts.expectedNftTokenId}`,
    );
  }

  const posPool = toSubgraphPoolId(position.poolAddress);
  if (posPool !== market.poolId || posPool !== market.pool?.id) {
    throw new Error(
      `cross-source mismatch: pool address position=${posPool} market.poolId=${market.poolId} market.pool.id=${market.pool?.id}`,
    );
  }

  const t0 = position.token0.toLowerCase();
  const t1 = position.token1.toLowerCase();
  if (t0 !== market.pool.token0?.id || t1 !== market.pool.token1?.id) {
    throw new Error(
      `cross-source mismatch: token pair position=${t0}/${t1} market=${market.pool.token0?.id}/${market.pool.token1?.id}`,
    );
  }

  if (String(position.fee) !== String(market.pool.feeTier)) {
    throw new Error(
      `cross-source mismatch: fee tier position=${position.fee} market=${market.pool.feeTier}`,
    );
  }
}

/**
 * @param {string} raw
 * @param {string} path
 */
function parseIntTick(raw, path) {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`${path} missing`);
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${path} is not a safe integer`);
  }
  return n;
}

/**
 * @param {object[]} hours
 * @param {number} start
 * @param {number} end
 */
function filterHours(hours, start, end) {
  return hours
    .filter((h) => {
      const t = Number(h.periodStartUnix);
      return Number.isFinite(t) && t >= start && t <= end;
    })
    .slice()
    .sort((a, b) => Number(a.periodStartUnix) - Number(b.periodStartUnix));
}

/**
 * @param {object[]} hours
 * @param {number} start
 * @param {number} end
 */
function windowMeta(hours, start, end) {
  const span = end - start;
  let covered = 0;
  if (hours.length > 0) {
    const first = Number(hours[0].periodStartUnix);
    const last = Number(hours[hours.length - 1].periodStartUnix);
    covered = Math.max(0, last - first);
  }
  return {
    startUnix: start,
    endUnix: end,
    observationCount: hours.length,
    coverageSeconds: covered,
    coverageRatio: span > 0 ? covered / span : null,
    boundBy: "periodStartUnix",
  };
}

/**
 * @param {object[]} hours
 * @param {number} minSamples
 * @param {string} label
 * @returns {object}
 */
function tickVolatilityProxy(hours, minSamples, label) {
  const withTick = hours.filter((h) => h.tick !== undefined && h.tick !== null);
  const sampleCount = withTick.length;

  if (hours.length === 0) {
    return {
      tickMovement: nullFeature(
        `empty_${label}_window_cannot_infer_volatility`,
      ),
      meanAbsTickDelta: nullFeature(
        `empty_${label}_window_cannot_infer_volatility`,
      ),
      sampleCount: 0,
      sufficient: false,
      reason: `empty_${label}_window`,
    };
  }

  if (sampleCount < minSamples) {
    return {
      tickMovement: nullFeature(
        `insufficient_tick_samples_${label}: ${sampleCount} < ${minSamples}`,
      ),
      meanAbsTickDelta: nullFeature(
        `insufficient_tick_samples_${label}: ${sampleCount} < ${minSamples}`,
      ),
      sampleCount,
      sufficient: false,
      reason: `insufficient_tick_samples_${label}`,
    };
  }

  const ticks = withTick.map((h) => parseIntTick(h.tick, "hour.tick"));
  const movement = ticks[ticks.length - 1] - ticks[0];
  const deltas = [];
  for (let i = 1; i < ticks.length; i++) {
    deltas.push(Math.abs(ticks[i] - ticks[i - 1]));
  }
  const meanAbs =
    deltas.reduce((a, b) => a + b, 0) / Math.max(deltas.length, 1);

  return {
    tickMovement: numberFeature(movement),
    meanAbsTickDelta: numberFeature(meanAbs),
    sampleCount,
    sufficient: true,
  };
}

/**
 * Empty fresh window → measured zero activity. Missing txCount on rows → null.
 * @param {object[]} hours
 * @param {string} label
 * @returns {MaybeNumber}
 */
function activityFromTxCount(hours, label) {
  if (hours.length === 0) {
    return numberFeature(0);
  }
  let sum = 0;
  for (const h of hours) {
    if (h.txCount === undefined || h.txCount === null) {
      return nullFeature(`missing_txCount_in_${label}_hour_rows`);
    }
    const n = Number(h.txCount);
    if (!Number.isFinite(n) || n < 0) {
      return nullFeature(`invalid_txCount_in_${label}_hour_rows`);
    }
    sum += n;
  }
  return numberFeature(sum);
}

/**
 * @param {object[]} hours
 * @param {string} field
 * @param {string} label
 * @returns {MaybeNumber}
 */
function sumTokenField(hours, field, label) {
  if (hours.length === 0) {
    return numberFeature(0);
  }
  let sum = 0;
  let any = false;
  for (const h of hours) {
    const raw = h[field];
    if (raw === undefined || raw === null) {
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return nullFeature(`invalid_${field}_in_${label}`);
    }
    sum += n;
    any = true;
  }
  if (!any) {
    return nullFeature(`missing_${field}_in_${label}`);
  }
  return numberFeature(sum);
}

/**
 * @param {MaybeNumber} current
 * @param {MaybeNumber} previous
 * @param {string} name
 * @returns {MaybeNumber}
 */
function ratioTrend(current, previous, name) {
  if (current.value === null) {
    return nullFeature(current.reason);
  }
  if (previous.value === null) {
    return nullFeature(previous.reason);
  }
  if (previous.value === 0) {
    if (current.value === 0) {
      return numberFeature(0);
    }
    return nullFeature(`cannot_ratio_${name}: previous_window_zero`);
  }
  return numberFeature(current.value / previous.value - 1);
}

/**
 * @param {MaybeNumber} fees24h
 * @param {object[]} hours24h
 * @param {{ usable: boolean, reasons: string[] }} usd
 * @returns {MaybeNumber}
 */
function feeToTvlProxy(fees24h, hours24h, usd) {
  if (!usd.usable) {
    return nullFeature(usd.reasons.join("; ") || "usd_data_unusable");
  }
  if (fees24h.value === null) {
    return nullFeature(fees24h.reason);
  }
  const tvls = hours24h
    .map((h) => (h.tvlUSD !== undefined ? Number(h.tvlUSD) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (tvls.length === 0) {
    return nullFeature("missing_positive_tvlUSD_for_fee_to_tvl");
  }
  const avgTvl = tvls.reduce((a, b) => a + b, 0) / tvls.length;
  return numberFeature(fees24h.value / avgTvl);
}

/**
 * @param {object[]} hours24h
 * @param {string} poolLiquidity
 * @returns {MaybeNumber}
 */
function liquidityTrend(hours24h, poolLiquidity) {
  const withLiq = hours24h.filter(
    (h) => h.liquidity !== undefined && h.liquidity !== null,
  );
  if (withLiq.length < 2) {
    return nullFeature("insufficient_liquidity_hour_samples_for_trend");
  }
  const first = Number(withLiq[0].liquidity);
  const last = Number(withLiq[withLiq.length - 1].liquidity);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return nullFeature("invalid_liquidity_for_trend");
  }
  // Prefer hour series endpoints; poolLiquidity retained in evidence only.
  void poolLiquidity;
  return numberFeature(last / first - 1);
}

/**
 * @param {object[]} hours24h
 * @returns {MaybeNumber}
 */
function tvlTrend(hours24h) {
  const withTvl = hours24h.filter(
    (h) => h.tvlUSD !== undefined && h.tvlUSD !== null,
  );
  if (withTvl.length < 2) {
    return nullFeature("insufficient_tvlUSD_hour_samples_for_trend");
  }
  const first = Number(withTvl[0].tvlUSD);
  const last = Number(withTvl[withTvl.length - 1].tvlUSD);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return nullFeature("invalid_tvlUSD_for_trend");
  }
  return numberFeature(last / first - 1);
}

/**
 * @param {object} pool
 * @param {object[]} hours24h
 */
export function assessUsdDataUsable(pool, hours24h) {
  /** @type {string[]} */
  const reasons = [];

  const poolVol0 = Number(pool.volumeToken0 ?? NaN);
  const poolVol1 = Number(pool.volumeToken1 ?? NaN);
  const poolVolUsd = Number(pool.volumeUSD ?? NaN);
  const poolTvlUsd = Number(pool.totalValueLockedUSD ?? NaN);
  const poolFeesUsd = Number(pool.feesUSD ?? NaN);

  const tokenVolumePositive =
    (Number.isFinite(poolVol0) && poolVol0 > 0) ||
    (Number.isFinite(poolVol1) && poolVol1 > 0);

  if (tokenVolumePositive && (!Number.isFinite(poolVolUsd) || poolVolUsd === 0)) {
    reasons.push("pool_volumeUSD_zero_or_missing_while_token_volume_positive");
  }

  if (Number.isFinite(poolTvlUsd) && poolTvlUsd >= SUSPICIOUS_TVL_USD) {
    reasons.push(`pool_totalValueLockedUSD_suspicious_ge_${SUSPICIOUS_TVL_USD}`);
  }

  if (
    Number.isFinite(poolFeesUsd) &&
    Number.isFinite(poolVolUsd) &&
    poolVolUsd > 0 &&
    poolFeesUsd > poolVolUsd
  ) {
    reasons.push("pool_feesUSD_exceeds_volumeUSD");
  }

  for (const h of hours24h) {
    const v0 = Number(h.volumeToken0 ?? 0);
    const v1 = Number(h.volumeToken1 ?? 0);
    const vUsd = h.volumeUSD !== undefined ? Number(h.volumeUSD) : NaN;
    if ((v0 > 0 || v1 > 0) && (!Number.isFinite(vUsd) || vUsd === 0)) {
      reasons.push("hour_volumeUSD_zero_or_missing_while_token_volume_positive");
      break;
    }
    const tvl = h.tvlUSD !== undefined ? Number(h.tvlUSD) : NaN;
    if (Number.isFinite(tvl) && tvl >= SUSPICIOUS_TVL_USD) {
      reasons.push("hour_tvlUSD_suspicious");
      break;
    }
  }

  // Deduplicate
  const unique = [...new Set(reasons)];
  return {
    usable: unique.length === 0,
    reasons: unique,
  };
}

/**
 * @param {object} parts
 * @returns {string[]}
 */
function collectMissingFlags(parts) {
  /** @type {string[]} */
  const flags = [];
  if (parts.hours6h.length === 0) flags.push("no_hour_rows_in_6h_window");
  if (parts.hours24h.length === 0) flags.push("no_hour_rows_in_24h_window");
  if (parts.hoursPrev6h.length === 0) flags.push("no_hour_rows_in_prev_6h_window");
  if (!parts.usd.usable) flags.push("usd_data_unusable");
  if (!parts.vol6h.sufficient) flags.push("insufficient_volatility_samples_6h");
  if (!parts.vol24h.sufficient) flags.push("insufficient_volatility_samples_24h");
  if (parts.market.windows?.swap?.truncated) flags.push("swap_sample_truncated");
  return flags;
}
