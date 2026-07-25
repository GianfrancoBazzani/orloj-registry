/**
 * Orloj Uniswap MCP JSON-RPC client (external HTTP).
 * Supports get_v3_position, claim_v3_fees, decrease_v3_position, create_v3_position.
 * Phase 1 AI decisions only propose HOLD or decrease — claim remains for later.
 *
 * Never log API keys, bearer tokens, or Authorization headers.
 */

/**
 * @typedef {object} McpClientOptions
 * @property {string} url
 * @property {string} apiKey
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} ParsedMcpToolResult
 * @property {boolean} isError
 * @property {string} text
 * @property {unknown} [data] JSON-parsed text when possible
 */

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

  const requestBody = buildToolsCallRequest(toolName, args, opts.id ?? 1);

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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP HTTP request failed: ${message}`);
  }

  const status = response.status;
  const rawText = await response.text();

  if (!response.ok) {
    // Do not echo response bodies that might contain sensitive upstream detail at length.
    const excerpt =
      rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
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
}

/**
 * @param {McpClientOptions} client
 * @param {{ chainId: string, nftTokenId: string }} params
 */
export async function getV3Position(client, { chainId, nftTokenId }) {
  const result = await callMcpTool(client, "get_v3_position", {
    chainId,
    nftTokenId,
  });
  if (result.data === undefined || typeof result.data !== "object") {
    throw new Error("get_v3_position did not return JSON object text");
  }
  return /** @type {Record<string, unknown>} */ (result.data);
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
 * @param {McpClientOptions} client
 * @param {{
 *   chainId: string,
 *   poolAddress: string,
 *   independentTokenAddress: string,
 *   independentTokenAmount: string,
 *   tickLower: number,
 *   tickUpper: number,
 *   slippageTolerance?: number,
 * }} params
 */
export async function createV3Position(client, params) {
  /** @type {Record<string, unknown>} */
  const args = {
    chainId: params.chainId,
    poolAddress: params.poolAddress,
    independentTokenAddress: params.independentTokenAddress,
    independentTokenAmount: params.independentTokenAmount,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
  };
  if (params.slippageTolerance !== undefined) {
    args.slippageTolerance = params.slippageTolerance;
  }
  const result = await callMcpTool(client, "create_v3_position", args);
  return result.data ?? result.text;
}
