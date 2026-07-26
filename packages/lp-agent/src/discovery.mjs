/**
 * Discover which V3 NFTs to evaluate this run.
 * Default: list_v3_positions (require truncated=false).
 * NFT_TOKEN_ID: optional filter/debug only (source=env_filter).
 */

import { listV3Positions } from "./orloj-mcp-client.mjs";
import { DEFAULT_CHAIN_ID } from "./config.mjs";

const UNSIGNED_DECIMAL_RE = /^(0|[1-9]\d*)$/;

/**
 * @typedef {object} DiscoveredPosition
 * @property {string} nftTokenId
 * @property {string} [poolAddress]
 * @property {string} [liquidity]
 * @property {Record<string, unknown>} [raw]
 */

/**
 * @typedef {object} DiscoveryResult
 * @property {"env_filter"|"list_v3_positions"} source
 * @property {boolean} truncated
 * @property {number} count
 * @property {number | null} totalOwned
 * @property {string[]} nftTokenIds
 * @property {DiscoveredPosition[]} positions
 */

/**
 * @param {object} client Orloj MCP client options
 * @param {{ chainId: string, nftTokenId: string | null }} config
 * @param {{ listPositions?: typeof listV3Positions }} [deps]
 * @returns {Promise<DiscoveryResult>}
 */
export async function discoverManagedPositions(client, config, deps = {}) {
  if (config.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `discoverManagedPositions only supports chainId ${DEFAULT_CHAIN_ID}`,
    );
  }

  if (typeof config.nftTokenId === "string" && config.nftTokenId !== "") {
    if (!UNSIGNED_DECIMAL_RE.test(config.nftTokenId)) {
      throw new Error(
        "NFT_TOKEN_ID must be a decimal integer string without leading zeros",
      );
    }
    return {
      source: "env_filter",
      truncated: false,
      count: 1,
      totalOwned: null,
      nftTokenIds: [config.nftTokenId],
      positions: [{ nftTokenId: config.nftTokenId }],
    };
  }

  const listFn = deps.listPositions ?? listV3Positions;
  const listed = await listFn(client, { chainId: config.chainId });

  if (listed.truncated !== false) {
    throw new Error(
      "list_v3_positions.truncated must be false before autonomous all-position management " +
        `(truncated=${JSON.stringify(listed.truncated)}, totalOwned=${JSON.stringify(listed.totalOwned)}, ` +
        `count=${JSON.stringify(listed.count)}) — reduce owned positions or set NFT_TOKEN_ID filter`,
    );
  }
  if (!Array.isArray(listed.positions)) {
    throw new Error("list_v3_positions.positions must be an array");
  }

  /** @type {DiscoveredPosition[]} */
  const active = [];
  for (const raw of listed.positions) {
    if (raw === null || typeof raw !== "object") {
      throw new Error("list_v3_positions.positions entries must be objects");
    }
    const id = /** @type {Record<string, unknown>} */ (raw).nftTokenId;
    if (typeof id !== "string" || !UNSIGNED_DECIMAL_RE.test(id)) {
      throw new Error(
        "list_v3_positions entry missing valid nftTokenId decimal string",
      );
    }
    const liquidity = /** @type {Record<string, unknown>} */ (raw).liquidity;
    // Skip fully closed positions (zero liquidity) when the list exposes liquidity.
    if (typeof liquidity === "string" && liquidity === "0") {
      continue;
    }
    active.push({
      nftTokenId: id,
      poolAddress:
        typeof raw.poolAddress === "string" ? raw.poolAddress : undefined,
      liquidity: typeof liquidity === "string" ? liquidity : undefined,
      raw: /** @type {Record<string, unknown>} */ (raw),
    });
  }

  if (active.length === 0) {
    return {
      source: "list_v3_positions",
      truncated: false,
      count: 0,
      totalOwned:
        typeof listed.totalOwned === "number" ? listed.totalOwned : null,
      nftTokenIds: [],
      positions: [],
    };
  }

  return {
    source: "list_v3_positions",
    truncated: false,
    count: active.length,
    totalOwned:
      typeof listed.totalOwned === "number" ? listed.totalOwned : null,
    nftTokenIds: active.map((p) => p.nftTokenId),
    positions: active,
  };
}
