/** Catalog / ZeroClaw selection id — must stay stable across regenerations. */
export const LP_MANAGER_MCP_ID = "orloj-lp-manager";

export type InternalLpManifest = {
  name: string;
  url: string;
  chainId: number;
  address: false;
  implementation: false;
  contractName: string;
  description: string;
  platform: string;
  toolCount: number;
  tokens: string[];
  interactionType: "mixed";
};

export function isLpChatExecuteEnabled(): boolean {
  const raw = process.env.LP_AGENT_CHAT_EXECUTE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Shared internal MCP definition for catalog + resolveMcpServers.
 * Returns null when LP_AGENT_MCP_URL is unset (feature off).
 * Keep this module free of Next `@/` imports so Node tests can load it.
 */
export function getInternalLpManagerManifest(): InternalLpManifest | null {
  const url = process.env.LP_AGENT_MCP_URL?.trim();
  if (!url) return null;
  const executeEnabled = isLpChatExecuteEnabled();
  return {
    name: LP_MANAGER_MCP_ID,
    url,
    chainId: 11155111,
    address: false,
    implementation: false,
    contractName: "Graph LP Manager",
    description:
      "Live Graph-powered analysis and guarded management of existing Uniswap V3 positions on Sepolia. One cycle per call; does not create an initial LP.",
    platform: "Sepolia",
    toolCount: executeEnabled ? 2 : 1,
    tokens: ["Uniswap V3"],
    interactionType: "mixed",
  };
}
