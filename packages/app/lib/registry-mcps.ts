import type { Mcp } from "@/components/data";
import {
  getInternalLpManagerManifest,
  toCatalogMcp,
} from "@/lib/lp-agent-mcp";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BSC",
  100: "Gnosis",
  137: "Polygon",
  42161: "Arbitrum",
  8453: "Base",
  43114: "Avalanche",
  11155111: "Sepolia",
};

// Chain-agnostic MCPs (e.g. uniswap) target a chain per tool call rather than being bound to
// one, so the registry manifest reports `chainId: null` for them. They get their own chain
// label instead of a numeric network — matching how the filter rail treats it as one more
// selectable chain.
const MULTICHAIN = "Multichain";

// chainId 0 is the registry's own sentinel for the chain-agnostic row (see
// DbPool::upsert_uniswap_entry), so it stands in for "no single chain" on our side too.
const MULTICHAIN_ID = 0;

const COLORS = ["verdigris", "brass", "wine", "blue"] as const;

interface RegistryMcp {
  name: string;
  url: string;
  chainId: number | null;
  address: string | false;
  implementation: string | null | false;
  contractName: string;
  description?: string;
  platform?: string;
  toolCount?: number;
  tokens?: string[];
  interactionType?: string;
  nativeToken?: boolean;
  symbol?: string;
  decimals?: number;
}

function interactionType(
  value: string | undefined,
): Mcp["interactionType"] {
  if (value === "transactional" || value === "mixed") return value;
  return "read-only";
}

function safeText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
  return clean.slice(0, max) || fallback;
}

function chainLabel(chainId: number | null): string {
  if (chainId === null || chainId === MULTICHAIN_ID) return MULTICHAIN;
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

function mapToMcp(item: RegistryMcp, registryUrl: string): Mcp {
  const chainId = item.chainId ?? MULTICHAIN_ID;
  const chain = chainLabel(item.chainId);
  const tokens = Array.isArray(item.tokens)
    ? [
        ...new Set(
          item.tokens
            .slice(0, 8)
            .map((token) => safeText(token, 32))
            .filter(Boolean),
        ),
      ]
    : item.nativeToken && item.symbol
      ? [item.symbol]
      : [];
  return {
    id: item.name,
    name: safeText(item.contractName, 80, "Unnamed MCP"),
    author: typeof item.address === "string" ? item.address : item.name,
    summary:
      safeText(item.description, 280) ||
      `Typed blockchain tools for ${safeText(item.contractName, 80, "this contract")} on ${chain}.`,
    chain,
    chainId,
    platform: safeText(item.platform, 48, chain),
    tokens,
    interactionType: interactionType(item.interactionType),
    contract: typeof item.address === "string" ? item.address : "",
    mcpUrl: `${registryUrl}${item.url}`,
    tags: item.nativeToken ? ["Native Token"] : [],
    interfaces: Number.isFinite(item.toolCount) ? item.toolCount ?? 0 : 0,
    callsLast24h: 0,
    audited: false,
    audits: [],
    verified: false,
    stars: 0,
    color: COLORS[chainId % COLORS.length],
  };
}

export async function fetchMcps(): Promise<Mcp[]> {
  const registryUrl = process.env.REGISTRY_URL;
  const publicRegistryUrl = process.env.PUBLIC_REGISTRY_URL ?? registryUrl;
  let mcps: Mcp[] = [];
  if (registryUrl) {
    try {
      const res = await fetch(`${registryUrl}/mcp`, { cache: "no-store" });
      if (res.ok) {
        const data: RegistryMcp[] = await res.json();
        mcps = data.map((item) => mapToMcp(item, publicRegistryUrl ?? registryUrl));
      }
    } catch {
      // Registry down — still surface the internal LP Manager when configured.
    }
  }

  const internal = getInternalLpManagerManifest();
  if (internal) {
    mcps = mcps.filter((m) => m.id !== internal.name);
    mcps = [toCatalogMcp(internal), ...mcps];
  }
  return mcps;
}
