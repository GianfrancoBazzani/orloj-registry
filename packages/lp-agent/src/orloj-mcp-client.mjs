/**
 * Orloj Uniswap MCP JSON-RPC client (external HTTP).
 * Supports get_v3_position, claim_v3_fees, decrease_v3_position, create_v3_position.
 * Phase 1 AI decisions only propose HOLD or decrease — claim remains for later.
 *
 * Never log API keys, bearer tokens, or Authorization headers.
 */

import { DEFAULT_CHAIN_ID } from "./config.mjs";

/**
 * @typedef {object} McpClientOptions
 * @property {string} url
 * @property {string} apiKey
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 */

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} ParsedMcpToolResult
 * @property {boolean} isError
 * @property {string} text
 * @property {unknown} [data] JSON-parsed text when possible
 */

/**
 * @typedef {object} V3Position
 * @property {string} chainId
 * @property {string} walletAddress
 * @property {string} nftTokenId
 * @property {string} poolAddress
 * @property {string} token0
 * @property {string} token1
 * @property {string} fee
 * @property {string} tickLower
 * @property {string} tickUpper
 * @property {string} liquidity
 * @property {string} tokensOwed0
 * @property {string} tokensOwed1
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UNSIGNED_DECIMAL_RE = /^(0|[1-9]\d*)$/;
const SIGNED_DECIMAL_RE = /^-?(0|[1-9]\d*)$/;

const GET_V3_POSITION_FIELDS = [
  "chainId",
  "walletAddress",
  "nftTokenId",
  "poolAddress",
  "token0",
  "token1",
  "fee",
  "tickLower",
  "tickUpper",
  "liquidity",
  "tokensOwed0",
  "tokensOwed1",
];

/**
 * Redact secrets from strings that may be surfaced in errors.
 * @param {string} text
 * @param {string} [apiKey]
 * @returns {string}
 */
export function redactSecrets(text, apiKey) {
  if (typeof text !== "string" || text === "") {
    return text;
  }
  let out = text;
  if (typeof apiKey === "string" && apiKey !== "") {
    out = out.split(apiKey).join("[REDACTED]");
    const bearer = `Bearer ${apiKey}`;
    out = out.split(bearer).join("Bearer [REDACTED]");
  }
  // Defense in depth if a bearer token appears without a known key match.
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return out;
}

/**
 * Build a JSON-RPC tools/call request body (no secrets).
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string | number} [id]
 */
export function buildToolsCallRequest(toolName, args, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args ?? {},
    },
  };
}

/**
 * Parse a JSON-RPC MCP tools/call HTTP response body.
 * Pure / fixture-friendly — does not perform network I/O.
 *
 * @param {unknown} body
 * @returns {ParsedMcpToolResult}
 */
export function parseMcpToolsCallResponse(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("MCP response must be a JSON object");
  }

  /** @type {Record<string, unknown>} */
  const rpc = /** @type {Record<string, unknown>} */ (body);

  if (rpc.error !== undefined && rpc.error !== null) {
    const err = rpc.error;
    if (typeof err === "object" && err !== null && !Array.isArray(err)) {
      const code = "code" in err ? err.code : undefined;
      const message =
        "message" in err && typeof err.message === "string"
          ? err.message
          : "unknown JSON-RPC error";
      throw new Error(`MCP JSON-RPC error code=${code}: ${message}`);
    }
    throw new Error("MCP JSON-RPC error with unrecognized shape");
  }

  if (!("result" in rpc) || rpc.result === undefined || rpc.result === null) {
    throw new Error("MCP response missing result");
  }

  const result = rpc.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("MCP result must be an object");
  }

  /** @type {Record<string, unknown>} */
  const toolResult = /** @type {Record<string, unknown>} */ (result);
  const isError = toolResult.isError === true;

  const content = toolResult.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result.content must be a non-empty array");
  }

  const first = content[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new Error("MCP content[0] must be an object");
  }

  const text = /** @type {Record<string, unknown>} */ (first).text;
  if (typeof text !== "string") {
    throw new Error("MCP content[0].text must be a string");
  }

  /** @type {ParsedMcpToolResult} */
  const parsed = { isError, text };

  if (text.trim() !== "") {
    try {
      parsed.data = JSON.parse(text);
    } catch {
      // Tool may return plain-text errors; leave data undefined.
    }
  }

  if (isError) {
    throw new Error(`MCP tool error: ${text}`);
  }

  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(
      `get_v3_position.${field} must be a 20-byte 0x-prefixed address`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireUnsignedDecimalString(value, field) {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_RE.test(value)) {
    throw new Error(
      `get_v3_position.${field} must be an unsigned decimal integer string`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireSignedDecimalString(value, field) {
  if (typeof value !== "string" || !SIGNED_DECIMAL_RE.test(value)) {
    throw new Error(
      `get_v3_position.${field} must be a signed decimal integer string`,
    );
  }
  return value;
}

/**
 * Strict validation of a get_v3_position payload against the request.
 *
 * @param {unknown} data
 * @param {{ chainId: string, nftTokenId: string }} request
 * @returns {V3Position}
 */
export function validateGetV3Position(data, request) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("get_v3_position must return a non-null JSON object");
  }

  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (data);

  for (const field of GET_V3_POSITION_FIELDS) {
    if (!(field in obj) || obj[field] === null || obj[field] === undefined) {
      throw new Error(`get_v3_position missing required field: ${field}`);
    }
  }

  const chainIdRaw = obj.chainId;
  const chainId =
    typeof chainIdRaw === "number"
      ? String(chainIdRaw)
      : typeof chainIdRaw === "string"
        ? chainIdRaw
        : null;
  if (chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `get_v3_position.chainId must be ${DEFAULT_CHAIN_ID}; got ${JSON.stringify(chainIdRaw)}`,
    );
  }
  if (request.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `get_v3_position request chainId must be ${DEFAULT_CHAIN_ID}`,
    );
  }

  const nftTokenId = requireUnsignedDecimalString(obj.nftTokenId, "nftTokenId");
  if (nftTokenId !== request.nftTokenId) {
    throw new Error(
      `get_v3_position.nftTokenId ${JSON.stringify(nftTokenId)} does not match request ${JSON.stringify(request.nftTokenId)}`,
    );
  }

  return {
    chainId,
    walletAddress: requireAddress(obj.walletAddress, "walletAddress"),
    nftTokenId,
    poolAddress: requireAddress(obj.poolAddress, "poolAddress"),
    token0: requireAddress(obj.token0, "token0"),
    token1: requireAddress(obj.token1, "token1"),
    fee: requireUnsignedDecimalString(obj.fee, "fee"),
    tickLower: requireSignedDecimalString(obj.tickLower, "tickLower"),
    tickUpper: requireSignedDecimalString(obj.tickUpper, "tickUpper"),
    liquidity: requireUnsignedDecimalString(obj.liquidity, "liquidity"),
    tokensOwed0: requireUnsignedDecimalString(obj.tokensOwed0, "tokensOwed0"),
    tokensOwed1: requireUnsignedDecimalString(obj.tokensOwed1, "tokensOwed1"),
  };
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function readMcpBodyText(response, signal) {
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
 * @param {unknown} err
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @param {string} [phase]
 */
function mapMcpTransportError(err, apiKey, timeoutMs, phase) {
  const name = err && typeof err === "object" && "name" in err ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw, apiKey);
  if (name === "AbortError" || /aborted/i.test(message)) {
    return new Error(`MCP request timed out after ${timeoutMs}ms`);
  }
  const prefix =
    phase === "body read" ? "MCP HTTP body read failed" : "MCP HTTP request failed";
  return new Error(`${prefix}: ${message}`);
}

/**
 * @param {McpClientOptions} client
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {{ id?: string | number }} [opts]
 * @returns {Promise<ParsedMcpToolResult>}
 */
export async function callMcpTool(client, toolName, args, opts = {}) {
  if (!client || typeof client.url !== "string" || client.url.trim() === "") {
    throw new Error("callMcpTool requires client.url");
  }
  if (typeof client.apiKey !== "string" || client.apiKey.trim() === "") {
    throw new Error("callMcpTool requires client.apiKey");
  }
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw new Error("callMcpTool requires toolName");
  }

  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const timeoutMs =
    client.timeoutMs === undefined || client.timeoutMs === null
      ? DEFAULT_MCP_TIMEOUT_MS
      : client.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }

  const requestBody = buildToolsCallRequest(toolName, args, opts.id ?? 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(client.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${client.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      throw mapMcpTransportError(err, client.apiKey, timeoutMs);
    }

    let rawText;
    try {
      rawText = await readMcpBodyText(response, controller.signal);
    } catch (err) {
      throw mapMcpTransportError(err, client.apiKey, timeoutMs, "body read");
    }

    const status = response.status;
    if (!response.ok) {
      const excerptRaw =
        rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
      const excerpt = redactSecrets(excerptRaw, client.apiKey);
      throw new Error(
        `MCP HTTP ${status}${excerpt ? `: ${excerpt}` : ""}`.trim(),
      );
    }

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw new Error(`MCP HTTP ${status} returned non-JSON body`);
    }

    return parseMcpToolsCallResponse(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {McpClientOptions} client
 * @param {{ chainId: string, nftTokenId: string }} params
 * @returns {Promise<V3Position>}
 */
export async function getV3Position(client, { chainId, nftTokenId }) {
  if (chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `get_v3_position only supports chainId ${DEFAULT_CHAIN_ID}`,
    );
  }
  if (typeof nftTokenId !== "string" || !UNSIGNED_DECIMAL_RE.test(nftTokenId)) {
    throw new Error(
      "nftTokenId must be an unsigned decimal integer string without leading zeros",
    );
  }

  const result = await callMcpTool(client, "get_v3_position", {
    chainId,
    nftTokenId,
  });
  return validateGetV3Position(result.data, { chainId, nftTokenId });
}

/**
 * Retained for later milestones. Phase 1 AI must not select CLAIM_FEES.
 * @param {McpClientOptions} client
 * @param {{ chainId: string, nftTokenId: string }} params
 */
export async function claimV3Fees(client, { chainId, nftTokenId }) {
  const result = await callMcpTool(client, "claim_v3_fees", {
    chainId,
    nftTokenId,
  });
  return result.data ?? result.text;
}

/**
 * Note: decrease_v3_position also collects accrued fees. Returned token amounts
 * describe withdrawn principal and exclude fees collected alongside.
 * @param {McpClientOptions} client
 * @param {{
 *   chainId: string,
 *   nftTokenId: string,
 *   liquidityPercentageToDecrease: number,
 *   slippageTolerance?: number,
 * }} params
 */
export async function decreaseV3Position(client, params) {
  if (params.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `decrease_v3_position only supports chainId ${DEFAULT_CHAIN_ID}`,
    );
  }
  if (typeof params.nftTokenId !== "string" || !UNSIGNED_DECIMAL_RE.test(params.nftTokenId)) {
    throw new Error(
      "nftTokenId must be an unsigned decimal integer string without leading zeros",
    );
  }
  if (
    typeof params.liquidityPercentageToDecrease !== "number" ||
    !Number.isInteger(params.liquidityPercentageToDecrease) ||
    params.liquidityPercentageToDecrease < 1 ||
    params.liquidityPercentageToDecrease > 100
  ) {
    throw new Error(
      "liquidityPercentageToDecrease must be an integer between 1 and 100",
    );
  }

  /** @type {Record<string, unknown>} */
  const args = {
    chainId: params.chainId,
    nftTokenId: params.nftTokenId,
    liquidityPercentageToDecrease: params.liquidityPercentageToDecrease,
  };
  if (params.slippageTolerance !== undefined) {
    args.slippageTolerance = params.slippageTolerance;
  }
  const result = await callMcpTool(client, "decrease_v3_position", args);
  return result.data ?? result.text;
}

/**
 * Managed create interface (PR #31). Not part of the autonomous manage loop.
 *
 * @param {McpClientOptions} client
 * @param {{
 *   chainId: string,
 *   tokenA: string,
 *   tokenB: string,
 *   maxTokenAAmount: string,
 *   maxTokenBAmount: string,
 *   rangeWidthBps?: number,
 *   poolAddress?: string,
 *   slippageTolerance?: number,
 * }} params
 */
export async function createV3Position(client, params) {
  if (params.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(
      `create_v3_position only supports chainId ${DEFAULT_CHAIN_ID}`,
    );
  }
  if (typeof params.tokenA !== "string" || params.tokenA.trim() === "") {
    throw new Error("create_v3_position requires non-empty string tokenA");
  }
  if (typeof params.tokenB !== "string" || params.tokenB.trim() === "") {
    throw new Error("create_v3_position requires non-empty string tokenB");
  }
  if (typeof params.maxTokenAAmount !== "string" || params.maxTokenAAmount.trim() === "") {
    throw new Error("create_v3_position requires non-empty string maxTokenAAmount");
  }
  if (typeof params.maxTokenBAmount !== "string" || params.maxTokenBAmount.trim() === "") {
    throw new Error("create_v3_position requires non-empty string maxTokenBAmount");
  }

  /** @type {Record<string, unknown>} */
  const args = {
    chainId: params.chainId,
    tokenA: params.tokenA,
    tokenB: params.tokenB,
    maxTokenAAmount: params.maxTokenAAmount,
    maxTokenBAmount: params.maxTokenBAmount,
  };
  if (params.rangeWidthBps !== undefined) args.rangeWidthBps = params.rangeWidthBps;
  if (params.poolAddress !== undefined) args.poolAddress = params.poolAddress;
  if (params.slippageTolerance !== undefined) {
    args.slippageTolerance = params.slippageTolerance;
  }
  const result = await callMcpTool(client, "create_v3_position", args);
  return result.data ?? result.text;
}

/**
 * Read-only pool state (token pair, fee, tick, liquidity). Not used in the manage loop.
 * @param {McpClientOptions} client
 * @param {{ chainId: string, poolAddress: string }} params
 */
export async function getV3PoolState(client, { chainId, poolAddress }) {
  if (chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(`get_v3_pool_state only supports chainId ${DEFAULT_CHAIN_ID}`);
  }
  if (typeof poolAddress !== "string" || !ADDRESS_RE.test(poolAddress)) {
    throw new Error("poolAddress must be a 20-byte 0x-prefixed address");
  }
  const result = await callMcpTool(client, "get_v3_pool_state", {
    chainId,
    poolAddress,
  });
  return result.data ?? result.text;
}

/**
 * List wallet-owned V3 positions (bootstrap / discovery when NFT_TOKEN_ID is unset).
 * @param {McpClientOptions} client
 * @param {{ chainId: string }} params
 * @returns {Promise<{
 *   chainId: string,
 *   walletAddress: string,
 *   count: number,
 *   totalOwned: number,
 *   truncated: boolean,
 *   positions: Array<{ nftTokenId: string, poolAddress: string, [key: string]: unknown }>,
 * }>}
 */
export async function listV3Positions(client, { chainId }) {
  if (chainId !== DEFAULT_CHAIN_ID) {
    throw new Error(`list_v3_positions only supports chainId ${DEFAULT_CHAIN_ID}`);
  }
  const result = await callMcpTool(client, "list_v3_positions", { chainId });
  const data = result.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("list_v3_positions response must be a JSON object");
  }
  const positions = /** @type {Record<string, unknown>} */ (data).positions;
  if (!Array.isArray(positions)) {
    throw new Error("list_v3_positions.positions must be an array");
  }
  return /** @type {any} */ (data);
}

/**
 * Resolve which NFT to manage: env NFT_TOKEN_ID, or exactly one listed position.
 * @param {McpClientOptions} client
 * @param {{ chainId: string, nftTokenId: string | null }} config
 * @param {{ listPositions?: typeof listV3Positions }} [deps]
 * @returns {Promise<{ nftTokenId: string, source: "env" | "list_v3_positions" }>}
 */
export async function resolveManagedNftTokenId(client, config, deps = {}) {
  if (typeof config.nftTokenId === "string" && config.nftTokenId !== "") {
    if (!UNSIGNED_DECIMAL_RE.test(config.nftTokenId)) {
      throw new Error(
        "NFT_TOKEN_ID must be a decimal integer string without leading zeros",
      );
    }
    return { nftTokenId: config.nftTokenId, source: "env" };
  }

  const listFn = deps.listPositions ?? listV3Positions;
  const listed = await listFn(client, { chainId: config.chainId });
  const positions = listed.positions ?? [];
  if (positions.length === 0) {
    throw new Error(
      "NFT_TOKEN_ID is unset and list_v3_positions returned no positions — set NFT_TOKEN_ID or open a position first",
    );
  }
  if (positions.length !== 1 || listed.truncated === true) {
    throw new Error(
      `NFT_TOKEN_ID is unset but wallet owns ${listed.totalOwned ?? positions.length} position(s)` +
        `${listed.truncated ? " (list truncated)" : ""} — set NFT_TOKEN_ID explicitly`,
    );
  }
  const id = positions[0]?.nftTokenId;
  if (typeof id !== "string" || !UNSIGNED_DECIMAL_RE.test(id)) {
    throw new Error("list_v3_positions[0].nftTokenId is missing or malformed");
  }
  return { nftTokenId: id, source: "list_v3_positions" };
}
