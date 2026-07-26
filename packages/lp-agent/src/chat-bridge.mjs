/**
 * Trusted config + per-agent state path helpers for the ZeroClaw chat MCP bridge.
 * Callers must never accept mode/chain/token/nft/state/retry from the model.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CHAIN_ID, loadConfig } from "./config.mjs";

export const LP_MANAGER_MCP_ID = "orloj-lp-manager";
export const ANALYZE_TOOL = "analyze_uniswap_v3_positions";
export const MANAGE_TOOL = "manage_uniswap_v3_positions";

/**
 * @param {string} agentId
 * @returns {string} hex sha256 — safe path component
 */
export function safeAgentStateKey(agentId) {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("agentId must be a non-empty string");
  }
  return createHash("sha256").update(agentId.trim(), "utf8").digest("hex");
}

/**
 * @param {string} stateDir
 * @param {string} agentId
 * @returns {string}
 */
export function stateFilePathForAgent(stateDir, agentId) {
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    throw new Error("stateDir must be a non-empty string");
  }
  const dir = stateDir.trim();
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safeAgentStateKey(agentId)}.json`);
}

/**
 * @typedef {object} TrustedChatBridgeInput
 * @property {string} agentId
 * @property {"observe"|"execute"} agentMode
 * @property {string} orlojMcpUrl
 * @property {string} orlojBearerToken
 * @property {string} theGraphApiKey
 * @property {string} aiChatCompletionsUrl
 * @property {string} aiApiKey
 * @property {string} aiModel
 * @property {string} stateDir
 * @property {string} [subgraphId]
 * @property {string} [graphGatewayBase]
 */

/**
 * Build LpAgentConfig for one chat-invoked cycle. Ignores any model/tool arguments.
 * @param {TrustedChatBridgeInput} input
 * @returns {ReturnType<typeof loadConfig>}
 */
export function buildTrustedChatConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("buildTrustedChatConfig requires an input object");
  }
  const {
    agentId,
    agentMode,
    orlojMcpUrl,
    orlojBearerToken,
    theGraphApiKey,
    aiChatCompletionsUrl,
    aiApiKey,
    aiModel,
    stateDir,
  } = input;

  if (agentMode !== "observe" && agentMode !== "execute") {
    throw new Error(
      `agentMode must be "observe" or "execute" (got ${JSON.stringify(agentMode)})`,
    );
  }

  const missing = [];
  const requireNonEmpty = (name, value) => {
    if (typeof value !== "string" || value.trim() === "") missing.push(name);
  };
  requireNonEmpty("agentId", agentId);
  requireNonEmpty("orlojMcpUrl", orlojMcpUrl);
  requireNonEmpty("orlojBearerToken", orlojBearerToken);
  requireNonEmpty("theGraphApiKey", theGraphApiKey);
  requireNonEmpty("aiChatCompletionsUrl", aiChatCompletionsUrl);
  requireNonEmpty("aiApiKey", aiApiKey);
  requireNonEmpty("aiModel", aiModel);
  requireNonEmpty("stateDir", stateDir);
  if (missing.length > 0) {
    throw new Error(`Missing required chat-bridge fields: ${missing.join(", ")}`);
  }

  /** @type {Record<string, string>} */
  const syntheticEnv = {
    ORLOJ_MCP_URL: orlojMcpUrl.trim(),
    ORLOJ_AGENT_BEARER_TOKEN: orlojBearerToken.trim(),
    THE_GRAPH_API_KEY: theGraphApiKey.trim(),
    AI_CHAT_COMPLETIONS_URL: aiChatCompletionsUrl.trim(),
    AI_API_KEY: aiApiKey.trim(),
    AI_MODEL: aiModel.trim(),
    AGENT_MODE: agentMode,
    CHAIN_ID: DEFAULT_CHAIN_ID,
    NFT_TOKEN_ID: "",
    LP_AGENT_STATE_FILE: stateFilePathForAgent(stateDir, agentId),
    LP_AGENT_ALLOW_CREATE_RETRY: "false",
  };

  if (typeof input.subgraphId === "string" && input.subgraphId.trim()) {
    syntheticEnv.THE_GRAPH_SUBGRAPH_ID = input.subgraphId.trim();
  }
  if (typeof input.graphGatewayBase === "string" && input.graphGatewayBase.trim()) {
    syntheticEnv.THE_GRAPH_GATEWAY_URL = input.graphGatewayBase.trim();
  }

  const config = loadConfig(syntheticEnv);
  // Hard invariants — never trust loadConfig alone for chat bridge.
  if (config.agentMode !== agentMode) {
    throw new Error("chat-bridge refused: agentMode mismatch after loadConfig");
  }
  if (config.nftTokenId !== null) {
    throw new Error("chat-bridge refused: nftTokenId must be null (all active positions)");
  }
  if (config.chainId !== DEFAULT_CHAIN_ID) {
    throw new Error("chat-bridge refused: chainId must be Sepolia");
  }
  if (config.allowCreateRetry !== false) {
    throw new Error("chat-bridge refused: allowCreateRetry must be false");
  }
  if (config.allowCreateRetryCycleId !== null) {
    throw new Error("chat-bridge refused: allowCreateRetryCycleId must be null");
  }
  return config;
}

/** Process-local same-agent concurrency guard. */
const locks = new Set();

/**
 * @param {string} agentId
 * @returns {() => void} release
 */
export function acquireAgentCycleLock(agentId) {
  const key = safeAgentStateKey(agentId);
  if (locks.has(key)) {
    const err = new Error(
      "LP agent cycle already in progress for this Orloj agent; retry after it finishes",
    );
    err.code = "LP_AGENT_BUSY";
    throw err;
  }
  locks.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks.delete(key);
  };
}

/** @returns {number} */
export function activeAgentCycleLockCount() {
  return locks.size;
}

/** Test helper only. */
export function resetAgentCycleLocksForTests() {
  locks.clear();
}
