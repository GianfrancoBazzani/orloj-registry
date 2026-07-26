/**
 * Deterministic market / position feature extraction.
 * Pure / zero-dependency: no network, AI, or MCP calls.
 *
 * Design: missing or insufficient evidence → `{ value: null, reason }` — never a
 * fabricated 0 that could be mistaken for measured inactivity (except where an
 * empty fresh window explicitly establishes zero *activity*).
 *
 * Safe finite Number math only — no decimal library.
 */

import { DEFAULT_CHAIN_ID, toSubgraphPoolId } from "./config.mjs";

export const WINDOW_6H_SECONDS = 6 * 60 * 60;
export const WINDOW_24H_SECONDS = 24 * 60 * 60;

/** Minimum hour rows with tick for a 6h volatility proxy. */
export const MIN_TICK_SAMPLES_6H = 3;
/** Minimum hour rows with tick for a 24h volatility proxy. */
export const MIN_TICK_SAMPLES_24H = 6;

/**
 * Minimum span between earliest and latest tick observation (seconds)
 * before a volatility proxy may be marked sufficient.
 */
export const MIN_TICK_SPAN_6H_SECONDS = 2 * 60 * 60;
export const MIN_TICK_SPAN_24H_SECONDS = 12 * 60 * 60;

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
  if (!Array.isArray(market.hourData)) {
    throw new Error("market.hourData must be a present array");
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
  const nearestBoundary = absLower <= absUpper ? "lower" : "upper";
  const nearestBoundaryDistance = Math.min(absLower, absUpper);
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

  const hours = market.hourData;
  // Current 6h: [now-6h, now] inclusive. Previous 6h: [now-12h, now-6h) excludes boundary.
  const hours6h = filterHours(hours, now - WINDOW_6H_SECONDS, now, {
    includeEnd: true,
  });
  const hours24h = filterHours(hours, now - WINDOW_24H_SECONDS, now, {
    includeEnd: true,
  });
  const hoursPrev6h = filterHours(
    hours,
    now - 2 * WINDOW_6H_SECONDS,
    now - WINDOW_6H_SECONDS,
    { includeEnd: false },
  );

  const usd = assessUsdDataUsable(market.pool, hours24h);

  const vol6h = tickVolatilityProxy(
    hours6h,
    MIN_TICK_SAMPLES_6H,
    MIN_TICK_SPAN_6H_SECONDS,
    "6h",
  );
  const vol24h = tickVolatilityProxy(
    hours24h,
    MIN_TICK_SAMPLES_24H,
    MIN_TICK_SPAN_24H_SECONDS,
    "24h",
  );

  const activity6h = sumRequiredField(hours6h, "txCount", "6h", {
    integer: true,
  });
  const activity24h = sumRequiredField(hours24h, "txCount", "24h", {
    integer: true,
  });

  const volumeToken0_6h = sumRequiredField(hours6h, "volumeToken0", "6h");
  const volumeToken1_6h = sumRequiredField(hours6h, "volumeToken1", "6h");
  const volumeToken0_24h = sumRequiredField(hours24h, "volumeToken0", "24h");
  const volumeToken1_24h = sumRequiredField(hours24h, "volumeToken1", "24h");
  const volumeToken0_prev6h = sumRequiredField(
    hoursPrev6h,
    "volumeToken0",
    "prev6h",
  );
  const volumeToken1_prev6h = sumRequiredField(
    hoursPrev6h,
    "volumeToken1",
    "prev6h",
  );

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
    ? sumRequiredField(hours6h, "feesUSD", "6h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");
  const feesUsd_prev6h = usd.usable
    ? sumRequiredField(hoursPrev6h, "feesUSD", "prev6h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");
  const feesUsd_24h = usd.usable
    ? sumRequiredField(hours24h, "feesUSD", "24h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const feeTrend_6h = usd.usable
    ? ratioTrend(feesUsd_6h, feesUsd_prev6h, "feesUSD")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const feeToTvl24h = feeToTvlProxy(feesUsd_24h, hours24h, usd);

  const liquidityTrend24h = endpointTrend(
    hours24h,
    "liquidity",
    "liquidity_24h",
  );
  const tvlTrend24h = usd.usable
    ? endpointTrend(hours24h, "tvlUSD", "tvlUSD_24h")
    : nullFeature(usd.reasons.join("; ") || "usd_data_unusable");

  const features = {
    position: {
      nftTokenId: position.nftTokenId,
      chainId: position.chainId,
      poolAddress: toSubgraphPoolId(position.poolAddress),
      tickLower,
      tickUpper,
      positionLiquidity: position.liquidity,
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
      nearestBoundary,
      nearestBoundaryDistance,
      normalizedRangePosition,
    },
    windows: {
      nowUnix: now,
      h6: windowMeta(hours6h, now - WINDOW_6H_SECONDS, now, true),
      h24: windowMeta(hours24h, now - WINDOW_24H_SECONDS, now, true),
      prev6h: windowMeta(
        hoursPrev6h,
        now - 2 * WINDOW_6H_SECONDS,
        now - WINDOW_6H_SECONDS,
        false,
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
      positionLiquidity: position.liquidity,
      poolLiquidity: market.pool.liquidity,
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
    evidence: {
      hourRowsTotal: hours.length,
      hourRows6h: hours6h.length,
      hourRows24h: hours24h.length,
      hourRowsPrev6h: hoursPrev6h.length,
      swapRowsSampled: Array.isArray(market.swaps) ? market.swaps.length : 0,
    },
  };

  features.missingInputFlags = collectMissingFlags(features, market);
  return features;
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
  if (
    opts.expectedNftTokenId !== undefined &&
    opts.expectedNftTokenId !== position.nftTokenId
  ) {
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
 * @param {string|number} raw
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
 * @param {unknown} raw
 * @param {string} path
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function parseNonNegativeFinite(raw, path) {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: `missing_${path}` };
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: `non_finite_${path}` };
  }
  if (n < 0) {
    return { ok: false, reason: `negative_${path}` };
  }
  return { ok: true, value: n };
}

/**
 * @param {object[]} hours
 * @param {number} start
 * @param {number} end
 * @param {{ includeEnd: boolean }} opts
 */
function filterHours(hours, start, end, opts) {
  return hours
    .filter((h) => {
      const t = Number(h.periodStartUnix);
      if (!Number.isFinite(t)) return false;
      if (t < start) return false;
      if (opts.includeEnd) return t <= end;
      return t < end;
    })
    .slice()
    .sort((a, b) => Number(a.periodStartUnix) - Number(b.periodStartUnix));
}

/**
 * @param {object[]} hours
 * @param {number} start
 * @param {number} end
 * @param {boolean} includeEnd
 */
function windowMeta(hours, start, end, includeEnd) {
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
    includeEnd,
    observationCount: hours.length,
    coverageSeconds: covered,
    coverageRatio: span > 0 ? covered / span : null,
    boundBy: "periodStartUnix",
  };
}

/**
 * @param {object[]} hours
 * @param {number} minSamples
 * @param {number} minSpanSeconds
 * @param {string} label
 */
function tickVolatilityProxy(hours, minSamples, minSpanSeconds, label) {
  if (hours.length === 0) {
    return {
      tickMovement: nullFeature(
        `empty_${label}_window_cannot_infer_volatility`,
      ),
      meanAbsTickDelta: nullFeature(
        `empty_${label}_window_cannot_infer_volatility`,
      ),
      sampleCount: 0,
      observationSpanSeconds: 0,
      minSpanSeconds,
      sufficient: false,
      reason: `empty_${label}_window`,
    };
  }

  const withTick = [];
  for (const h of hours) {
    if (h.tick === undefined || h.tick === null) {
      return {
        tickMovement: nullFeature(`missing_tick_in_${label}_hour_rows`),
        meanAbsTickDelta: nullFeature(`missing_tick_in_${label}_hour_rows`),
        sampleCount: 0,
        observationSpanSeconds: 0,
        minSpanSeconds,
        sufficient: false,
        reason: `missing_tick_in_${label}_hour_rows`,
      };
    }
    withTick.push(h);
  }

  const timestamps = withTick.map((h) => Number(h.periodStartUnix));
  const unique = new Set(timestamps.map(String));
  if (unique.size !== timestamps.length) {
    return {
      tickMovement: nullFeature(`duplicate_periodStartUnix_in_${label}_window`),
      meanAbsTickDelta: nullFeature(
        `duplicate_periodStartUnix_in_${label}_window`,
      ),
      sampleCount: withTick.length,
      observationSpanSeconds: 0,
      minSpanSeconds,
      sufficient: false,
      reason: `duplicate_periodStartUnix_in_${label}_window`,
    };
  }

  const span =
    timestamps.length > 0
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;
  const sampleCount = withTick.length;

  if (sampleCount < minSamples) {
    return {
      tickMovement: nullFeature(
        `insufficient_tick_samples_${label}: ${sampleCount} < ${minSamples}`,
      ),
      meanAbsTickDelta: nullFeature(
        `insufficient_tick_samples_${label}: ${sampleCount} < ${minSamples}`,
      ),
      sampleCount,
      observationSpanSeconds: span,
      minSpanSeconds,
      sufficient: false,
      reason: `insufficient_tick_samples_${label}`,
    };
  }

  if (span < minSpanSeconds) {
    return {
      tickMovement: nullFeature(
        `insufficient_tick_span_${label}: ${span}s < ${minSpanSeconds}s`,
      ),
      meanAbsTickDelta: nullFeature(
        `insufficient_tick_span_${label}: ${span}s < ${minSpanSeconds}s`,
      ),
      sampleCount,
      observationSpanSeconds: span,
      minSpanSeconds,
      sufficient: false,
      reason: `insufficient_tick_span_${label}`,
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
    observationSpanSeconds: span,
    minSpanSeconds,
    sufficient: true,
  };
}

/**
 * Empty window → measured 0. Nonempty → every row must have the field;
 * never publish a partial sum as complete.
 *
 * @param {object[]} hours
 * @param {string} field
 * @param {string} label
 * @param {{ integer?: boolean }} [opts]
 * @returns {MaybeNumber}
 */
function sumRequiredField(hours, field, label, opts = {}) {
  if (hours.length === 0) {
    return numberFeature(0);
  }
  let sum = 0;
  for (let i = 0; i < hours.length; i++) {
    const parsed = parseNonNegativeFinite(
      hours[i][field],
      `${field}_in_${label}[${i}]`,
    );
    if (!parsed.ok) {
      return nullFeature(parsed.reason);
    }
    if (opts.integer && !Number.isSafeInteger(parsed.value)) {
      return nullFeature(`unsafe_integer_${field}_in_${label}[${i}]`);
    }
    const next = sum + parsed.value;
    if (!Number.isFinite(next)) {
      return nullFeature(`overflow_summing_${field}_in_${label}`);
    }
    if (opts.integer && !Number.isSafeInteger(next)) {
      return nullFeature(`overflow_summing_${field}_in_${label}`);
    }
    sum = next;
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
  const ratio = current.value / previous.value - 1;
  if (!Number.isFinite(ratio)) {
    return nullFeature(`non_finite_ratio_${name}`);
  }
  return numberFeature(ratio);
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
  if (hours24h.length === 0) {
    return nullFeature("empty_24h_window_for_fee_to_tvl");
  }
  let tvlSum = 0;
  for (let i = 0; i < hours24h.length; i++) {
    const parsed = parseNonNegativeFinite(
      hours24h[i].tvlUSD,
      `tvlUSD_in_24h[${i}]`,
    );
    if (!parsed.ok) {
      return nullFeature(parsed.reason);
    }
    if (parsed.value <= 0) {
      return nullFeature(`non_positive_tvlUSD_in_24h[${i}]`);
    }
    tvlSum += parsed.value;
    if (!Number.isFinite(tvlSum)) {
      return nullFeature("overflow_summing_tvlUSD_for_fee_to_tvl");
    }
  }
  const avgTvl = tvlSum / hours24h.length;
  const ratio = fees24h.value / avgTvl;
  if (!Number.isFinite(ratio)) {
    return nullFeature("non_finite_fee_to_tvl");
  }
  return numberFeature(ratio);
}

/**
 * Endpoint trend over hour series; every row must have the field.
 * @param {object[]} hours
 * @param {string} field
 * @param {string} label
 * @returns {MaybeNumber}
 */
function endpointTrend(hours, field, label) {
  if (hours.length < 2) {
    return nullFeature(`insufficient_${label}_samples_for_trend`);
  }
  const values = [];
  for (let i = 0; i < hours.length; i++) {
    const parsed = parseNonNegativeFinite(
      hours[i][field],
      `${field}_in_${label}[${i}]`,
    );
    if (!parsed.ok) {
      return nullFeature(parsed.reason);
    }
    values.push(parsed.value);
  }
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) {
    return nullFeature(`cannot_trend_${label}: first_value_zero`);
  }
  const ratio = last / first - 1;
  if (!Number.isFinite(ratio)) {
    return nullFeature(`non_finite_trend_${label}`);
  }
  return numberFeature(ratio);
}

/**
 * Fail closed when required USD evidence is missing, non-finite, negative,
 * inconsistent with positive raw TVL/volume, fees>volume, or suspiciously large.
 *
 * @param {object} pool
 * @param {object[]} hours24h
 */
export function assessUsdDataUsable(pool, hours24h) {
  /** @type {string[]} */
  const reasons = [];

  const requiredPoolUsd = [
    ["volumeUSD", pool.volumeUSD],
    ["totalValueLockedUSD", pool.totalValueLockedUSD],
    ["feesUSD", pool.feesUSD],
  ];
  for (const [name, raw] of requiredPoolUsd) {
    const parsed = parseNonNegativeFinite(raw, `pool.${name}`);
    if (!parsed.ok) {
      reasons.push(parsed.reason);
    }
  }

  const poolVol0 = parseNonNegativeFinite(
    pool.volumeToken0 ?? "0",
    "pool.volumeToken0",
  );
  const poolVol1 = parseNonNegativeFinite(
    pool.volumeToken1 ?? "0",
    "pool.volumeToken1",
  );
  const poolTvl0 = parseNonNegativeFinite(
    pool.totalValueLockedToken0 ?? "0",
    "pool.totalValueLockedToken0",
  );
  const poolTvl1 = parseNonNegativeFinite(
    pool.totalValueLockedToken1 ?? "0",
    "pool.totalValueLockedToken1",
  );

  for (const p of [poolVol0, poolVol1, poolTvl0, poolTvl1]) {
    if (!p.ok) reasons.push(p.reason);
  }

  const poolVolUsd = parseNonNegativeFinite(pool.volumeUSD, "pool.volumeUSD");
  const poolTvlUsd = parseNonNegativeFinite(
    pool.totalValueLockedUSD,
    "pool.totalValueLockedUSD",
  );
  const poolFeesUsd = parseNonNegativeFinite(pool.feesUSD, "pool.feesUSD");

  if (
    poolVol0.ok &&
    poolVol1.ok &&
    poolVolUsd.ok &&
    (poolVol0.value > 0 || poolVol1.value > 0) &&
    poolVolUsd.value === 0
  ) {
    reasons.push("pool_volumeUSD_zero_while_token_volume_positive");
  }

  if (
    poolTvl0.ok &&
    poolTvl1.ok &&
    poolTvlUsd.ok &&
    (poolTvl0.value > 0 || poolTvl1.value > 0) &&
    poolTvlUsd.value === 0
  ) {
    reasons.push("pool_totalValueLockedUSD_zero_while_token_tvl_positive");
  }

  if (poolTvlUsd.ok && poolTvlUsd.value >= SUSPICIOUS_TVL_USD) {
    reasons.push(`pool_totalValueLockedUSD_suspicious_ge_${SUSPICIOUS_TVL_USD}`);
  }

  if (
    poolFeesUsd.ok &&
    poolVolUsd.ok &&
    poolVolUsd.value > 0 &&
    poolFeesUsd.value > poolVolUsd.value
  ) {
    reasons.push("pool_feesUSD_exceeds_volumeUSD");
  }

  for (let i = 0; i < hours24h.length; i++) {
    const h = hours24h[i];
    for (const field of ["volumeUSD", "feesUSD", "tvlUSD"]) {
      const parsed = parseNonNegativeFinite(h[field], `hour[${i}].${field}`);
      if (!parsed.ok) {
        reasons.push(parsed.reason);
        continue;
      }
      if (field === "tvlUSD" && parsed.value >= SUSPICIOUS_TVL_USD) {
        reasons.push(`hour_tvlUSD_suspicious_at_${i}`);
      }
    }
    const v0 = parseNonNegativeFinite(
      h.volumeToken0 ?? "0",
      `hour[${i}].volumeToken0`,
    );
    const v1 = parseNonNegativeFinite(
      h.volumeToken1 ?? "0",
      `hour[${i}].volumeToken1`,
    );
    const vUsd = parseNonNegativeFinite(h.volumeUSD, `hour[${i}].volumeUSD`);
    const fUsd = parseNonNegativeFinite(h.feesUSD, `hour[${i}].feesUSD`);
    if (
      v0.ok &&
      v1.ok &&
      vUsd.ok &&
      (v0.value > 0 || v1.value > 0) &&
      vUsd.value === 0
    ) {
      reasons.push(`hour_volumeUSD_zero_while_token_volume_positive_at_${i}`);
    }
    if (fUsd.ok && vUsd.ok && vUsd.value > 0 && fUsd.value > vUsd.value) {
      reasons.push(`hour_feesUSD_exceeds_volumeUSD_at_${i}`);
    }
  }

  const unique = [...new Set(reasons)];
  return {
    usable: unique.length === 0,
    reasons: unique,
  };
}

/**
 * @param {object} features
 * @param {object} market
 * @returns {string[]}
 */
function collectMissingFlags(features, market) {
  /** @type {string[]} */
  const flags = [];

  if (features.windows.h6.observationCount === 0) {
    flags.push("no_hour_rows_in_6h_window");
  }
  if (features.windows.h24.observationCount === 0) {
    flags.push("no_hour_rows_in_24h_window");
  }
  if (features.windows.prev6h.observationCount === 0) {
    flags.push("no_hour_rows_in_prev_6h_window");
  }
  if (!features.usdDataUsable.usable) flags.push("usd_data_unusable");
  if (!features.volatility.tickProxy6h.sufficient) {
    flags.push("insufficient_volatility_samples_6h");
  }
  if (!features.volatility.tickProxy24h.sufficient) {
    flags.push("insufficient_volatility_samples_24h");
  }
  if (market.windows?.swap?.truncated) flags.push("swap_sample_truncated");

  /** @type {Array<[string, MaybeNumber]>} */
  const maybeNumbers = [
    ["activity.txCountSum6h", features.activity.txCountSum6h],
    ["activity.txCountSum24h", features.activity.txCountSum24h],
    ["volumes.token0_6h", features.volumes.token0_6h],
    ["volumes.token1_6h", features.volumes.token1_6h],
    ["volumes.token0_24h", features.volumes.token0_24h],
    ["volumes.token1_24h", features.volumes.token1_24h],
    ["volumes.token0_prev6h", features.volumes.token0_prev6h],
    ["volumes.token1_prev6h", features.volumes.token1_prev6h],
    ["volumes.trendToken0_6hVsPrev6h", features.volumes.trendToken0_6hVsPrev6h],
    ["volumes.trendToken1_6hVsPrev6h", features.volumes.trendToken1_6hVsPrev6h],
    ["fees.usd_6h", features.fees.usd_6h],
    ["fees.usd_prev6h", features.fees.usd_prev6h],
    ["fees.usd_24h", features.fees.usd_24h],
    ["fees.trend_6hVsPrev6h", features.fees.trend_6hVsPrev6h],
    ["fees.feeToTvl_24h", features.fees.feeToTvl_24h],
    ["liquidity.trend_24h", features.liquidity.trend_24h],
    ["tvl.trend_24h", features.tvl.trend_24h],
    [
      "volatility.tickProxy6h.tickMovement",
      features.volatility.tickProxy6h.tickMovement,
    ],
    [
      "volatility.tickProxy24h.tickMovement",
      features.volatility.tickProxy24h.tickMovement,
    ],
  ];

  for (const [path, feat] of maybeNumbers) {
    if (feat && feat.value === null) {
      flags.push(`null:${path}`);
    }
  }

  return flags;
}
