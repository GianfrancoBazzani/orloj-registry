/**
 * The Graph client for Uniswap V3 Sepolia market context.
 * Load-bearing: no RPC/static fallback. Fail closed on transport, GraphQL,
 * indexing-error, stale _meta, missing pool, or malformed essential fields.
 * Present empty arrays for hours/swaps with fresh _meta = inactive market (OK).
 * Missing/null hour or swap arrays are fail-closed (not treated as inactivity).
 *
 * Large Graph numeric values are preserved as strings. No feature math here.
 * Swap intensity (later) should use PoolHourData.txCount, not sampled swap counts.
 */

import { DEFAULT_SUBGRAPH_ID, toSubgraphPoolId } from "./config.mjs";
import { redactSecrets } from "./orloj-mcp-client.mjs";

/**
 * Default max age of indexed block timestamp vs wall clock.
 * Live Sepolia smoke showed ~10s lag; 60 minutes is the chosen default in the
 * 30–60m preference band. Always exposed on the result as evidence.
 */
export const DEFAULT_MAX_INDEXED_AGE_SECONDS = 60 * 60;

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
  $hourEndUnix: Int!
  $hourLimit: Int!
  $swapStartUnix: BigInt!
  $swapEndUnix: BigInt!
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
    where: {
      pool: $poolId
      periodStartUnix_gte: $hourStartUnix
      periodStartUnix_lte: $hourEndUnix
    }
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
    where: {
      pool: $poolId
      timestamp_gte: $swapStartUnix
      timestamp_lte: $swapEndUnix
    }
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

const UNSIGNED_INT_RE = /^(0|[1-9]\d*)$/;
const SIGNED_INT_RE = /^-?(0|[1-9]\d*)$/;
/** BigDecimal-like: optional sign, digits, optional fractional part. */
const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Preserve Graph numerics as strings. Reject unsafe JS numbers (non-safe integers).
 * Fractional values must arrive as strings (The Graph BigDecimal practice).
 *
 * @param {unknown} value
 * @param {string} path
 * @param {{ kind: "uint" | "int" | "decimal" | "hash" | "id" }} opts
 * @returns {string}
 */
export function asGraphScalar(value, path, opts) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Graph field ${path} is not a finite number`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Graph field ${path} is an unsafe JS number; require a string scalar`,
      );
    }
    value = String(value);
  } else if (typeof value === "bigint") {
    value = value.toString();
  } else if (typeof value !== "string") {
    throw new Error(
      `Graph field ${path} must be a string or safe integer (got ${typeof value})`,
    );
  }

  const s = value.trim();
  if (s === "") {
    throw new Error(`Graph field ${path} is an empty string`);
  }

  switch (opts.kind) {
    case "uint":
      if (!UNSIGNED_INT_RE.test(s)) {
        throw new Error(`Graph field ${path} must be an unsigned integer string`);
      }
      return s;
    case "int":
      if (!SIGNED_INT_RE.test(s)) {
        throw new Error(`Graph field ${path} must be a signed integer string`);
      }
      return s;
    case "decimal":
      if (!DECIMAL_RE.test(s)) {
        throw new Error(`Graph field ${path} must be a decimal string`);
      }
      return s;
    case "hash":
      if (!/^0x[0-9a-fA-F]+$/.test(s)) {
        throw new Error(`Graph field ${path} must be a 0x-hex string`);
      }
      return s;
    case "id":
      return s;
    default:
      throw new Error(`Unknown scalar kind for ${path}`);
  }
}

/** @deprecated use asGraphScalar — kept for call-site clarity in tests */
export function asGraphString(value, path) {
  return asGraphScalar(value, path, { kind: "decimal" });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function asAddressString(value, path) {
  const s = asGraphScalar(value, path, { kind: "id" }).toLowerCase();
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
 * @param {number} ts
 * @param {number} start
 * @param {number} end
 * @param {string} path
 */
function assertInWindow(ts, start, end, path) {
  if (!Number.isFinite(ts)) {
    throw new Error(`Graph ${path} is not numeric`);
  }
  if (ts < start || ts > end) {
    throw new Error(
      `Graph ${path} ${ts} is outside requested window [${start}, ${end}]`,
    );
  }
}

/**
 * Validate Graph data and normalize numerics to strings.
 * `poolHourDatas` and `swaps` must be present arrays; only `[]` means inactivity.
 *
 * @param {Record<string, unknown>} data
 * @param {{
 *   poolId: string,
 *   subgraphId: string,
 *   nowSeconds: number,
 *   maxIndexedAgeSeconds: number,
 *   hourStartUnix: number,
 *   hourEndUnix: number,
 *   swapStartUnix: number,
 *   swapEndUnix: number,
 *   swapRowLimit: number,
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

  const blockNumber = asGraphScalar(block.number, "_meta.block.number", {
    kind: "uint",
  });
  const blockHash = asGraphScalar(block.hash, "_meta.block.hash", { kind: "hash" });
  const blockTimestamp = asGraphScalar(block.timestamp, "_meta.block.timestamp", {
    kind: "uint",
  });
  const indexedAt = Number(blockTimestamp);
  if (!Number.isSafeInteger(indexedAt)) {
    throw new Error("Graph _meta.block.timestamp is not a safe integer");
  }
  const ageSeconds = ctx.nowSeconds - indexedAt;
  if (ageSeconds > ctx.maxIndexedAgeSeconds) {
    throw new Error(
      `Graph indexed block is stale: age=${ageSeconds}s exceeds max=${ctx.maxIndexedAgeSeconds}s`,
    );
  }
  if (ageSeconds < -300) {
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
    tick: asGraphScalar(poolObj.tick, "pool.tick", { kind: "int" }),
    sqrtPrice: asGraphScalar(poolObj.sqrtPrice, "pool.sqrtPrice", { kind: "uint" }),
    liquidity: asGraphScalar(poolObj.liquidity, "pool.liquidity", { kind: "uint" }),
    feeTier: asGraphScalar(poolObj.feeTier, "pool.feeTier", { kind: "uint" }),
    totalValueLockedUSD: optionalScalar(
      poolObj.totalValueLockedUSD,
      "pool.totalValueLockedUSD",
      "decimal",
    ),
    totalValueLockedToken0: optionalScalar(
      poolObj.totalValueLockedToken0,
      "pool.totalValueLockedToken0",
      "decimal",
    ),
    totalValueLockedToken1: optionalScalar(
      poolObj.totalValueLockedToken1,
      "pool.totalValueLockedToken1",
      "decimal",
    ),
    volumeUSD: optionalScalar(poolObj.volumeUSD, "pool.volumeUSD", "decimal"),
    volumeToken0: optionalScalar(poolObj.volumeToken0, "pool.volumeToken0", "decimal"),
    volumeToken1: optionalScalar(poolObj.volumeToken1, "pool.volumeToken1", "decimal"),
    feesUSD: optionalScalar(poolObj.feesUSD, "pool.feesUSD", "decimal"),
    token0,
    token1,
  };

  if (!Array.isArray(data.poolHourDatas)) {
    throw new Error("Graph poolHourDatas must be a present array");
  }
  if (!Array.isArray(data.swaps)) {
    throw new Error("Graph swaps must be a present array");
  }

  const hourData = normalizeHourRows(
    data.poolHourDatas,
    ctx.hourStartUnix,
    ctx.hourEndUnix,
  );
  const swapFetched = normalizeSwapRows(
    data.swaps,
    ctx.swapStartUnix,
    ctx.swapEndUnix,
  );
  const truncated = swapFetched.length > ctx.swapRowLimit;
  const swaps = truncated
    ? swapFetched.slice(0, ctx.swapRowLimit)
    : swapFetched;

  return {
    subgraphId: ctx.subgraphId,
    poolId: ctx.poolId,
    queriedAt: ctx.nowSeconds,
    meta: {
      blockNumber,
      blockHash,
      blockTimestamp,
      hasIndexingErrors: false,
      ageSeconds,
      maxIndexedAgeSeconds: ctx.maxIndexedAgeSeconds,
      deployment:
        typeof metaObj.deployment === "string" ? metaObj.deployment : undefined,
    },
    pool,
    hourData,
    swaps,
    windows: {
      hour: {
        startUnix: ctx.hourStartUnix,
        endUnix: ctx.hourEndUnix,
        boundBy: "periodStartUnix",
        rowCount: hourData.length,
      },
      swap: {
        startUnix: ctx.swapStartUnix,
        endUnix: ctx.swapEndUnix,
        boundBy: "timestamp",
        rowCount: swaps.length,
        fetchedCount: swapFetched.length,
        limit: ctx.swapRowLimit,
        truncated,
        complete: !truncated,
        // Intensity features must use hour txCount, not this sample size.
        sampleNote:
          "swap rows are a capped sample; use PoolHourData.txCount for intensity",
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
    symbol: asGraphScalar(t.symbol, `${path}.symbol`, { kind: "id" }),
    decimals: asGraphScalar(t.decimals, `${path}.decimals`, { kind: "uint" }),
    name: typeof t.name === "string" ? t.name : undefined,
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {"uint" | "int" | "decimal"} kind
 * @returns {string | undefined}
 */
function optionalScalar(value, path, kind) {
  if (value === null || value === undefined) {
    return undefined;
  }
  return asGraphScalar(value, path, { kind });
}

/**
 * @param {unknown[]} rows
 * @param {number} hourStartUnix
 * @param {number} hourEndUnix
 */
function normalizeHourRows(rows, hourStartUnix, hourEndUnix) {
  /** @type {ReturnType<typeof normalizeHourRow>[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeHourRow(rows[i], i);
    assertInWindow(
      Number(row.periodStartUnix),
      hourStartUnix,
      hourEndUnix,
      `poolHourDatas[${i}].periodStartUnix`,
    );
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
    id: asGraphScalar(r.id, `${path}.id`, { kind: "id" }),
    periodStartUnix: asGraphScalar(r.periodStartUnix, `${path}.periodStartUnix`, {
      kind: "uint",
    }),
    tick: optionalScalar(r.tick, `${path}.tick`, "int"),
    liquidity: optionalScalar(r.liquidity, `${path}.liquidity`, "uint"),
    sqrtPrice: optionalScalar(r.sqrtPrice, `${path}.sqrtPrice`, "uint"),
    tvlUSD: optionalScalar(r.tvlUSD, `${path}.tvlUSD`, "decimal"),
    volumeUSD: optionalScalar(r.volumeUSD, `${path}.volumeUSD`, "decimal"),
    volumeToken0: optionalScalar(r.volumeToken0, `${path}.volumeToken0`, "decimal"),
    volumeToken1: optionalScalar(r.volumeToken1, `${path}.volumeToken1`, "decimal"),
    feesUSD: optionalScalar(r.feesUSD, `${path}.feesUSD`, "decimal"),
    open: optionalScalar(r.open, `${path}.open`, "decimal"),
    high: optionalScalar(r.high, `${path}.high`, "decimal"),
    low: optionalScalar(r.low, `${path}.low`, "decimal"),
    close: optionalScalar(r.close, `${path}.close`, "decimal"),
    token0Price: optionalScalar(r.token0Price, `${path}.token0Price`, "decimal"),
    token1Price: optionalScalar(r.token1Price, `${path}.token1Price`, "decimal"),
    txCount: optionalScalar(r.txCount, `${path}.txCount`, "uint"),
  };
}

/**
 * @param {unknown[]} rows
 * @param {number} swapStartUnix
 * @param {number} swapEndUnix
 */
function normalizeSwapRows(rows, swapStartUnix, swapEndUnix) {
  /** @type {ReturnType<typeof normalizeSwapRow>[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeSwapRow(rows[i], i);
    assertInWindow(
      Number(row.timestamp),
      swapStartUnix,
      swapEndUnix,
      `swaps[${i}].timestamp`,
    );
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
    id: asGraphScalar(r.id, `${path}.id`, { kind: "id" }),
    timestamp: asGraphScalar(r.timestamp, `${path}.timestamp`, { kind: "uint" }),
    tick: asGraphScalar(r.tick, `${path}.tick`, { kind: "int" }),
    amount0: asGraphScalar(r.amount0, `${path}.amount0`, { kind: "decimal" }),
    amount1: asGraphScalar(r.amount1, `${path}.amount1`, { kind: "decimal" }),
    amountUSD: optionalScalar(r.amountUSD, `${path}.amountUSD`, "decimal"),
    sqrtPriceX96: optionalScalar(r.sqrtPriceX96, `${path}.sqrtPriceX96`, "uint"),
  };
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function readBodyText(response, signal) {
  if (signal.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  return await Promise.race([
    response.text(),
    new Promise((_, reject) => {
      const onAbort = () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
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
  const hourEndUnix = nowSeconds;
  const swapStartUnix = nowSeconds - swapLookbackSeconds;
  const swapEndUnix = nowSeconds;

  // Request one extra swap row so we can report truncated vs complete honestly.
  const variables = {
    poolId,
    hourStartUnix,
    hourEndUnix,
    hourLimit: hourRowLimit,
    swapStartUnix: String(swapStartUnix),
    swapEndUnix: String(swapEndUnix),
    swapLimit: swapRowLimit + 1,
  };

  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
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
      throw mapTransportError(err, client.apiKey, timeoutMs);
    }

    let rawText;
    try {
      rawText = await readBodyText(response, controller.signal);
    } catch (err) {
      throw mapTransportError(err, client.apiKey, timeoutMs, "body read");
    }

    const status = response.status;
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
      hourEndUnix,
      swapStartUnix,
      swapEndUnix,
      swapRowLimit,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} err
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @param {string} [phase]
 */
function mapTransportError(err, apiKey, timeoutMs, phase) {
  const name = err && typeof err === "object" && "name" in err ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw, apiKey);
  if (name === "AbortError" || /aborted/i.test(message)) {
    return new Error(`Graph request timed out after ${timeoutMs}ms`);
  }
  const prefix =
    phase === "body read"
      ? "Graph HTTP body read failed"
      : "Graph HTTP request failed";
  return new Error(`${prefix}: ${message}`);
}
