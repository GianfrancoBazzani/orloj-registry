/**
 * Environment configuration for the LP agent.
 * Phase 1: load from process.env only (no dotenv dependency).
 */

export const DEFAULT_SUBGRAPH_ID =
  "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR";

export const DEFAULT_GRAPH_GATEWAY_BASE =
  "https://gateway.thegraph.com/api/subgraphs/id";

export const DEFAULT_CHAIN_ID = "11155111";

/** @typedef {"observe" | "execute"} AgentMode */

/**
 * @typedef {object} LpAgentConfig
 * @property {string} orlojMcpUrl
 * @property {string} orlojMcpApiKey
 * @property {string} theGraphApiKey
 * @property {string} subgraphId
 * @property {string} graphGatewayBase
 * @property {string} graphUrl
 * @property {string} aiChatCompletionsUrl
 * @property {string} aiApiKey
 * @property {string} aiModel
 * @property {AgentMode} agentMode
 * @property {string} nftTokenId
 * @property {string} chainId
 */

/**
 * Normalize an Orloj checksummed pool address for Uniswap V3 subgraph entity IDs.
 * @param {string} poolAddress
 * @returns {string}
 */
export function toSubgraphPoolId(poolAddress) {
  if (typeof poolAddress !== "string" || poolAddress.trim() === "") {
    throw new Error("poolAddress must be a non-empty string");
  }
  return poolAddress.trim().toLowerCase();
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {LpAgentConfig}
 */
export function loadConfig(env = process.env) {
  const missing = [];
  const requireString = (key) => {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(key);
      return "";
    }
    return value.trim();
  };

  const orlojMcpUrl = requireString("ORLOJ_MCP_URL");
  const orlojMcpApiKey = requireString("ORLOJ_MCP_API_KEY");
  const theGraphApiKey = requireString("THE_GRAPH_API_KEY");
  const aiChatCompletionsUrl = requireString("AI_CHAT_COMPLETIONS_URL");
  const aiApiKey = requireString("AI_API_KEY");
  const aiModel = requireString("AI_MODEL");
  const nftTokenId = requireString("NFT_TOKEN_ID");

  const subgraphId =
    (typeof env.THE_GRAPH_SUBGRAPH_ID === "string" &&
      env.THE_GRAPH_SUBGRAPH_ID.trim()) ||
    DEFAULT_SUBGRAPH_ID;
  const graphGatewayBase =
    (typeof env.THE_GRAPH_GATEWAY_URL === "string" &&
      env.THE_GRAPH_GATEWAY_URL.trim()) ||
    DEFAULT_GRAPH_GATEWAY_BASE;
  const chainId =
    (typeof env.CHAIN_ID === "string" && env.CHAIN_ID.trim()) ||
    DEFAULT_CHAIN_ID;

  const modeRaw =
    typeof env.AGENT_MODE === "string" && env.AGENT_MODE.trim() !== ""
      ? env.AGENT_MODE.trim()
      : "observe";
  if (modeRaw !== "observe" && modeRaw !== "execute") {
    throw new Error(
      `AGENT_MODE must be "observe" or "execute" (got ${JSON.stringify(modeRaw)})`,
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  if (!/^\d+$/.test(nftTokenId)) {
    throw new Error("NFT_TOKEN_ID must be a decimal integer string");
  }
  if (!/^\d+$/.test(chainId)) {
    throw new Error("CHAIN_ID must be a decimal integer string");
  }

  const gateway = graphGatewayBase.replace(/\/$/, "");
  return {
    orlojMcpUrl,
    orlojMcpApiKey,
    theGraphApiKey,
    subgraphId,
    graphGatewayBase: gateway,
    graphUrl: `${gateway}/${subgraphId}`,
    aiChatCompletionsUrl,
    aiApiKey,
    aiModel,
    agentMode: /** @type {AgentMode} */ (modeRaw),
    nftTokenId,
    chainId,
  };
}
