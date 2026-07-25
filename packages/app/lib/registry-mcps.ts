import type { Mcp } from "@/components/data";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BSC",
  100: "Gnosis",
  137: "Polygon",
  42161: "Arbitrum",
  8453: "Base",
  43114: "Avalanche",
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
  version: string;
  toolCount: number;
  nativeToken?: boolean;
  symbol?: string;
  decimals?: number;
}

function chainLabel(chainId: number | null): string {
  if (chainId === null || chainId === MULTICHAIN_ID) return MULTICHAIN;
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

function mapToMcp(item: RegistryMcp, registryUrl: string): Mcp {
  const chainId = item.chainId ?? MULTICHAIN_ID;
  return {
    id: item.name,
    name: item.contractName,
    author: typeof item.address === "string" ? item.address : item.name,
    summary: "",
    chain: chainLabel(item.chainId),
    chainId,
    contract: typeof item.address === "string" ? item.address : "",
    mcpUrl: `${registryUrl}${item.url}`,
    tags: item.nativeToken ? ["Native Token"] : [],
    interfaces: item.toolCount,
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
  if (!registryUrl) return [];
  const publicRegistryUrl = process.env.PUBLIC_REGISTRY_URL ?? registryUrl;
  try {
    const res = await fetch(`${registryUrl}/mcp`, { cache: "no-store" });
    if (!res.ok) return [];
    const data: RegistryMcp[] = await res.json();
    return data.map((item) => mapToMcp(item, publicRegistryUrl));
  } catch {
    return [];
  }
}
