/**
 * The Graph client for Uniswap V3 Sepolia market context.
 * Load-bearing: no RPC/static fallback. Fail closed on transport, GraphQL,
 * indexing-error, stale _meta, missing pool, or malformed essential fields.
 * Sparse/empty hour or swap rows with fresh _meta = inactive market (OK).
 *
 * Large Graph numeric values are preserved as strings. No feature math here.
 */

import { DEFAULT_SUBGRAPH_ID, toSubgraphPoolId } from "./config.mjs";
import { redactSecrets } from "./orloj-mcp-client.mjs";

/** Default max age of indexed block timestamp vs wall clock. */
export const DEFAULT_MAX_INDEXED_AGE_SECONDS = 6 * 60 * 60;

/** Default PoolHourData lookback (timestamp window, not row count). */
export const DEFAULT_HOUR_LOOKBACK_SECONDS = 48 * 60 * 60;

/** Default swap lookback (timestamp window). */
export const DEFAULT_SWAP_LOOKBACK_SECONDS = 24 * 60 * 60;

export const DEFAULT_HOUR_ROW_LIMIT = 48;
export const DEFAULT_SWAP_ROW_LIMIT = 50;
export const DEFAULT_GRAPH_TIMEOUT_MS = 30_000;

export const POOL_MARKET_CONTEXT_QUERY = `#graphql
query PoolMarketContext(
  $poolId: ID!
  $hourStartUnix: Int!
  $hourLimit: Int!
  $swapStartUnix: BigInt!
  $swapLimit: Int!
) {
  _meta {
    block { number hash timestamp }
    hasIndexingErrors
    deployment
  }
  pool(id: $poolId) {
    id
    tick
    sqrtPrice
    liquidity
    feeTier
    totalValueLockedUSD
    totalValueLockedToken0
    totalValueLockedToken1
    volumeUSD
    volumeToken0
    volumeToken1
    feesUSD
    token0 { id symbol decimals name }
    token1 { id symbol decimals name }
  }
  poolHourDatas(
    first: $hourLimit
    orderBy: periodStartUnix
    orderDirection: desc
    where: { pool: $poolId, periodStartUnix_gte: $hourStartUnix }
  ) {
    id
    periodStartUnix
    tick
    liquidity
    sqrtPrice
    tvlUSD
    volumeUSD
    volumeToken0
    volumeToken1
    feesUSD
    open
    high
    low
    close
    token0Price
    token1Price
    txCount
  }
  swaps(
    first: $swapLimit
    orderBy: timestamp
    orderDirection: desc
    where: { pool: $poolId, timestamp_gte: $swapStartUnix }
  ) {
    id
    timestamp
    tick
    amount0
    amount1
    amountUSD
    sqrtPriceX96
  }
}
`;

/**
 * @typedef {object} GraphClientOptions
 * @property {string} graphUrl
 * @property {string} apiKey
 * @property {string} [subgraphId]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {number} [maxIndexedAgeSeconds]
 * @property {number} [hourLookbackSeconds]
 * @property {number} [swapLookbackSeconds]
 * @property {number} [hourRowLimit]
 * @property {number} [swapRowLimit]
 * @property {() => number} [nowSeconds]
 */

/**
 * Coerce Graph scalar to string without doing feature math.
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
export function asGraphString(value, path) {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new Error(`Graph field ${path} is an empty string`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Graph field ${path} is not a finite number`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  throw new Error(
    `Graph field ${path} must be a string or number (got ${typeof value})`,
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function asAddressString(value, path) {
  const s = asGraphString(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) {
    throw new Error(`Graph field ${path} is not a 20-byte address`);
  }
  return s;
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
export function parseGraphHttpJson(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Graph response must be a JSON object");
  }
  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (body);
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const messages = obj.errors
      .map((e) =>
        e && typeof e === "object" && "message" in e
          ? String(/** @type {{ message: unknown }} */ (e).message)
          : "unknown",
      )
      .join("; ");
    throw new Error(`GraphQL errors: ${messages}`);
  }
  if (obj.data === null || typeof obj.data !== "object" || Array.isArray(obj.data)) {
    throw new Error("Graph response missing data object");
  }
  return /** @type {Record<string, unknown>} */ (obj.data);
}

/**
 * Validate Graph data and normalize numerics to strings.
 * Empty hour/swap arrays are allowed when _meta is fresh (caller checks staleness).
 *
 * @param {Record<string, unknown>} data
 * @param {{
 *   poolId: string,
 *   subgraphId: string,
 *   nowSeconds: number,
 *   maxIndexedAgeSeconds: number,
 *   hourStartUnix: number,
 *   swapStartUnix: number,
 * }} ctx
 */
export function normalizePoolMarketContext(data, ctx) {
  const metaRaw = data._meta;
  if (metaRaw === null || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    throw new Error("Graph _meta missing or malformed");
  }
  /** @type {Record<string, unknown>} */
  const metaObj = /** @type {Record<string, unknown>} */ (metaRaw);
  if (metaObj.hasIndexingErrors === true) {
    throw new Error("Graph subgraph has indexing errors");
  }
  if (metaObj.hasIndexingErrors !== false) {
    throw new Error("Graph _meta.hasIndexingErrors must be boolean false");
  }

  const blockRaw = metaObj.block;
  if (blockRaw === null || typeof blockRaw !== "object" || Array.isArray(blockRaw)) {
    throw new Error("Graph _meta.block missing or malformed");
  }
  /** @type {Record<string, unknown>} */
  const block = /** @type {Record<string, unknown>} */ (blockRaw);

  const blockNumber = asGraphString(block.number, "_meta.block.number");
  const blockHash = asGraphString(block.hash, "_meta.block.hash");
  const blockTimestamp = asGraphString(block.timestamp, "_meta.block.timestamp");
  const indexedAt = Number(blockTimestamp);
  if (!Number.isFinite(indexedAt)) {
    throw new Error("Graph _meta.block.timestamp is not numeric");
  }
  const ageSeconds = ctx.nowSeconds - indexedAt;
  if (ageSeconds > ctx.maxIndexedAgeSeconds) {
    throw new Error(
      `Graph indexed block is stale: age=${ageSeconds}s exceeds max=${ctx.maxIndexedAgeSeconds}s`,
    );
  }
  if (ageSeconds < -300) {
    // Clock skew guard — indexed "in the future" by more than 5 minutes.
    throw new Error(
      `Graph indexed block timestamp is in the future (age=${ageSeconds}s)`,
    );
  }

  const poolRaw = data.pool;
  if (poolRaw === null || poolRaw === undefined) {
    throw new Error(`Graph pool not found for id ${ctx.poolId}`);
  }
  if (typeof poolRaw !== "object" || Array.isArray(poolRaw)) {
    throw new Error("Graph pool is malformed");
  }
  /** @type {Record<string, unknown>} */
  const poolObj = /** @type {Record<string, unknown>} */ (poolRaw);

  const poolId = asAddressString(poolObj.id, "pool.id");
  if (poolId !== ctx.poolId) {
    throw new Error(
      `Graph pool.id ${poolId} does not match requested ${ctx.poolId}`,
    );
  }

  const token0 = normalizeToken(poolObj.token0, "pool.token0");
  const token1 = normalizeToken(poolObj.token1, "pool.token1");

  const pool = {
    id: poolId,
    tick: asGraphString(poolObj.tick, "pool.tick"),
    sqrtPrice: asGraphString(poolObj.sqrtPrice, "pool.sqrtPrice"),
    liquidity: asGraphString(poolObj.liquidity, "pool.liquidity"),
    feeTier: asGraphString(poolObj.feeTier, "pool.feeTier"),
    totalValueLockedUSD: optionalGraphString(
      poolObj.totalValueLockedUSD,
      "pool.totalValueLockedUSD",
    ),
    totalValueLockedToken0: optionalGraphString(
      poolObj.totalValueLockedToken0,
      "pool.totalValueLockedToken0",
    ),
    totalValueLockedToken1: optionalGraphString(
      poolObj.totalValueLockedToken1,
      "pool.totalValueLockedToken1",
    ),
    volumeUSD: optionalGraphString(poolObj.volumeUSD, "pool.volumeUSD"),
    volumeToken0: optionalGraphString(poolObj.volumeToken0, "pool.volumeToken0"),
    volumeToken1: optionalGraphString(poolObj.volumeToken1, "pool.volumeToken1"),
    feesUSD: optionalGraphString(poolObj.feesUSD, "pool.feesUSD"),
    token0,
    token1,
  };

  const hourData = normalizeHourRows(data.poolHourDatas, ctx.hourStartUnix);
  const swaps = normalizeSwapRows(data.swaps, ctx.swapStartUnix);

  return {
    subgraphId: ctx.subgraphId,
    poolId: ctx.poolId,
    queriedAt: ctx.nowSeconds,
    meta: {
      blockNumber,
      blockHash,
      blockTimestamp,
      hasIndexingErrors: false,
      deployment:
        typeof metaObj.deployment === "string" ? metaObj.deployment : undefined,
    },
    pool,
    hourData,
    swaps,
    windows: {
      hour: {
        startUnix: ctx.hourStartUnix,
        endUnix: ctx.nowSeconds,
        boundBy: "periodStartUnix",
        rowCount: hourData.length,
      },
      swap: {
        startUnix: ctx.swapStartUnix,
        endUnix: ctx.nowSeconds,
        boundBy: "timestamp",
        rowCount: swaps.length,
      },
    },
    inactivity: {
      noHourRows: hourData.length === 0,
      noSwapRows: swaps.length === 0,
    },
  };
}

/**
 * @param {unknown} tokenRaw
 * @param {string} path
 */
function normalizeToken(tokenRaw, path) {
  if (tokenRaw === null || typeof tokenRaw !== "object" || Array.isArray(tokenRaw)) {
    throw new Error(`Graph ${path} missing or malformed`);
  }
  /** @type {Record<string, unknown>} */
  const t = /** @type {Record<string, unknown>} */ (tokenRaw);
  return {
    id: asAddressString(t.id, `${path}.id`),
    symbol: asGraphString(t.symbol, `${path}.symbol`),
    decimals: asGraphString(t.decimals, `${path}.decimals`),
    name: typeof t.name === "string" ? t.name : undefined,
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string | undefined}
 */
function optionalGraphString(value, path) {
  if (value === null || value === undefined) {
    return undefined;
  }
  return asGraphString(value, path);
}

/**
 * @param {unknown} rows
 * @param {number} hourStartUnix
 */
function normalizeHourRows(rows, hourStartUnix) {
  if (rows === null || rows === undefined) {
    return [];
  }
  if (!Array.isArray(rows)) {
    throw new Error("Graph poolHourDatas must be an array");
  }
  /** @type {ReturnType<typeof normalizeHourRow>[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeHourRow(rows[i], i);
    const period = Number(row.periodStartUnix);
    if (!Number.isFinite(period)) {
      throw new Error(`Graph poolHourDatas[${i}].periodStartUnix not numeric`);
    }
    if (period < hourStartUnix) {
      throw new Error(
        `Graph poolHourDatas[${i}].periodStartUnix ${period} is outside requested window (>= ${hourStartUnix})`,
      );
    }
    out.push(row);
  }
  return out;
}

/**
 * @param {unknown} row
 * @param {number} index
 */
function normalizeHourRow(row, index) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`Graph poolHourDatas[${index}] malformed`);
  }
  /** @type {Record<string, unknown>} */
  const r = /** @type {Record<string, unknown>} */ (row);
  const path = `poolHourDatas[${index}]`;
  return {
    id: asGraphString(r.id, `${path}.id`),
    periodStartUnix: asGraphString(r.periodStartUnix, `${path}.periodStartUnix`),
    tick: optionalGraphString(r.tick, `${path}.tick`),
    liquidity: optionalGraphString(r.liquidity, `${path}.liquidity`),
    sqrtPrice: optionalGraphString(r.sqrtPrice, `${path}.sqrtPrice`),
    tvlUSD: optionalGraphString(r.tvlUSD, `${path}.tvlUSD`),
    volumeUSD: optionalGraphString(r.volumeUSD, `${path}.volumeUSD`),
    volumeToken0: optionalGraphString(r.volumeToken0, `${path}.volumeToken0`),
    volumeToken1: optionalGraphString(r.volumeToken1, `${path}.volumeToken1`),
    feesUSD: optionalGraphString(r.feesUSD, `${path}.feesUSD`),
    open: optionalGraphString(r.open, `${path}.open`),
    high: optionalGraphString(r.high, `${path}.high`),
    low: optionalGraphString(r.low, `${path}.low`),
    close: optionalGraphString(r.close, `${path}.close`),
    token0Price: optionalGraphString(r.token0Price, `${path}.token0Price`),
    token1Price: optionalGraphString(r.token1Price, `${path}.token1Price`),
    txCount: optionalGraphString(r.txCount, `${path}.txCount`),
  };
}

/**
 * @param {unknown} rows
 * @param {number} swapStartUnix
 */
function normalizeSwapRows(rows, swapStartUnix) {
  if (rows === null || rows === undefined) {
    return [];
  }
  if (!Array.isArray(rows)) {
    throw new Error("Graph swaps must be an array");
  }
  /** @type {ReturnType<typeof normalizeSwapRow>[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeSwapRow(rows[i], i);
    const ts = Number(row.timestamp);
    if (!Number.isFinite(ts)) {
      throw new Error(`Graph swaps[${i}].timestamp not numeric`);
    }
    if (ts < swapStartUnix) {
      throw new Error(
        `Graph swaps[${i}].timestamp ${ts} is outside requested window (>= ${swapStartUnix})`,
      );
    }
    out.push(row);
  }
  return out;
}

/**
 * @param {unknown} row
 * @param {number} index
 */
function normalizeSwapRow(row, index) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`Graph swaps[${index}] malformed`);
  }
  /** @type {Record<string, unknown>} */
  const r = /** @type {Record<string, unknown>} */ (row);
  const path = `swaps[${index}]`;
  return {
    id: asGraphString(r.id, `${path}.id`),
    timestamp: asGraphString(r.timestamp, `${path}.timestamp`),
    tick: asGraphString(r.tick, `${path}.tick`),
    amount0: asGraphString(r.amount0, `${path}.amount0`),
    amount1: asGraphString(r.amount1, `${path}.amount1`),
    amountUSD: optionalGraphString(r.amountUSD, `${path}.amountUSD`),
    sqrtPriceX96: optionalGraphString(r.sqrtPriceX96, `${path}.sqrtPriceX96`),
  };
}

/**
 * Fetch live pool market context from The Graph (load-bearing).
 *
 * @param {GraphClientOptions} client
 * @param {{ poolAddress: string }} params Orloj checksummed or lowercase pool address
 */
export async function fetchPoolMarketContext(client, { poolAddress }) {
  if (!client || typeof client.graphUrl !== "string" || client.graphUrl.trim() === "") {
    throw new Error("fetchPoolMarketContext requires client.graphUrl");
  }
  if (typeof client.apiKey !== "string" || client.apiKey.trim() === "") {
    throw new Error("fetchPoolMarketContext requires client.apiKey");
  }

  const poolId = toSubgraphPoolId(poolAddress);
  const subgraphId = client.subgraphId ?? DEFAULT_SUBGRAPH_ID;
  const timeoutMs = client.timeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;
  const maxIndexedAgeSeconds =
    client.maxIndexedAgeSeconds ?? DEFAULT_MAX_INDEXED_AGE_SECONDS;
  const hourLookbackSeconds =
    client.hourLookbackSeconds ?? DEFAULT_HOUR_LOOKBACK_SECONDS;
  const swapLookbackSeconds =
    client.swapLookbackSeconds ?? DEFAULT_SWAP_LOOKBACK_SECONDS;
  const hourRowLimit = client.hourRowLimit ?? DEFAULT_HOUR_ROW_LIMIT;
  const swapRowLimit = client.swapRowLimit ?? DEFAULT_SWAP_ROW_LIMIT;
  const nowSeconds = (client.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

  const hourStartUnix = nowSeconds - hourLookbackSeconds;
  const swapStartUnix = nowSeconds - swapLookbackSeconds;

  const variables = {
    poolId,
    hourStartUnix,
    hourLimit: hourRowLimit,
    swapStartUnix: String(swapStartUnix),
    swapLimit: swapRowLimit,
  };

  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(client.graphUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${client.apiKey}`,
      },
      body: JSON.stringify({
        query: POOL_MARKET_CONTEXT_QUERY,
        variables,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? err.name : "";
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(raw, client.apiKey);
    if (name === "AbortError" || /aborted/i.test(message)) {
      throw new Error(`Graph request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Graph HTTP request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  const rawText = await response.text();

  if (!response.ok) {
    const excerptRaw =
      rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
    const excerpt = redactSecrets(excerptRaw, client.apiKey);
    throw new Error(`Graph HTTP ${status}${excerpt ? `: ${excerpt}` : ""}`);
  }

  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Graph HTTP ${status} returned invalid JSON`);
  }

  const data = parseGraphHttpJson(body);
  return normalizePoolMarketContext(data, {
    poolId,
    subgraphId,
    nowSeconds,
    maxIndexedAgeSeconds,
    hourStartUnix,
    swapStartUnix,
  });
}
