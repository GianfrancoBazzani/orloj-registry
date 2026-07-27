import { resolve } from "node:path";
import {
  createLpAgentMcpDispatcher,
  type LpAgentMcpDispatcher,
} from "@orloj/lp-agent";
import type { Mcp } from "@/components/data";
import {
  getInternalLpManagerManifest,
  isLpChatExecuteEnabled,
  LP_MANAGER_MCP_ID,
  type InternalLpManifest,
} from "@/lib/internal-lp-manifest";

export {
  getInternalLpManagerManifest,
  isLpChatExecuteEnabled,
  LP_MANAGER_MCP_ID,
  type InternalLpManifest,
};

export function toCatalogMcp(manifest: InternalLpManifest): Mcp {
  return {
    id: manifest.name,
    name: manifest.contractName,
    author: "orloj",
    summary: manifest.description,
    chain: "Sepolia",
    chainId: manifest.chainId,
    platform: manifest.platform,
    tokens: manifest.tokens,
    interactionType: manifest.interactionType,
    contract: "",
    mcpUrl: manifest.url,
    tags: ["Internal", "Graph", "LP"],
    interfaces: manifest.toolCount,
    callsLast24h: 0,
    audited: false,
    audits: [],
    verified: true,
    stars: 0,
    color: "verdigris",
  };
}

/**
 * Collect required server env for a chat-bridge cycle. Names missing vars; never values.
 */
export function requireLpAgentServerEnv(): {
  registryUrl: string;
  theGraphApiKey: string;
  aiChatCompletionsUrl: string;
  aiApiKey: string;
  aiModel: string;
  stateDir: string;
} {
  const missing: string[] = [];
  const take = (key: string, fallbackKey?: string): string => {
    const primary = process.env[key]?.trim();
    if (primary) return primary;
    if (fallbackKey) {
      const fb = process.env[fallbackKey]?.trim();
      if (fb) return fb;
      missing.push(`${key} (or ${fallbackKey})`);
      return "";
    }
    missing.push(key);
    return "";
  };

  const registryUrl = take("REGISTRY_URL").replace(/\/$/, "");
  const theGraphApiKey = take("THE_GRAPH_API_KEY");
  const aiChatCompletionsUrl = take("LP_AGENT_AI_CHAT_COMPLETIONS_URL");
  const aiApiKey = take("LP_AGENT_AI_API_KEY", "ZEROCLAW_MODEL_API_KEY");
  const aiModel = take("LP_AGENT_AI_MODEL");
  const stateDirRaw = process.env.LP_AGENT_STATE_DIR?.trim() || ".lp-agent/state";

  if (missing.length > 0) {
    throw new Error(
      `LP Manager MCP misconfigured; missing: ${missing.join(", ")}`,
    );
  }

  // Resolve relative state dir against the app package cwd (Next server process).
  const stateDir = resolve(stateDirRaw);

  return {
    registryUrl,
    theGraphApiKey,
    aiChatCompletionsUrl,
    aiApiKey,
    aiModel,
    stateDir,
  };
}

export function createAppLpAgentDispatcher(input: {
  agentId: string;
  bearerToken: string;
}): LpAgentMcpDispatcher {
  const env = requireLpAgentServerEnv();
  const orlojMcpUrl = `${env.registryUrl}/interface/uniswap/mcp`;

  return createLpAgentMcpDispatcher({
    agentId: input.agentId,
    executeEnabled: isLpChatExecuteEnabled(),
    buildConfig: async () => ({
      orlojMcpUrl,
      orlojBearerToken: input.bearerToken,
      theGraphApiKey: env.theGraphApiKey,
      aiChatCompletionsUrl: env.aiChatCompletionsUrl,
      aiApiKey: env.aiApiKey,
      aiModel: env.aiModel,
      stateDir: env.stateDir,
    }),
  });
}
