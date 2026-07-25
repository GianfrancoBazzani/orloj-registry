import type { McpServerEntry } from "./mcp-block";

export const MAX_MCPS = 32;

export class UnknownMcpError extends Error {
  readonly mcpName: string;
  constructor(mcpName: string) {
    super(`Unknown MCP: ${mcpName}`);
    this.name = "UnknownMcpError";
    this.mcpName = mcpName;
  }
}

export class RegistryUnreachableError extends Error {
  constructor(cause?: unknown) {
    super("Registry manifest unreachable");
    this.name = "RegistryUnreachableError";
    this.cause = cause;
  }
}

type ManifestEntry = {
  name: string;
  url: string;
  contractName?: string | null;
};

// zeroclaw's tool prefix (`<server>__<tool>`) and the bundle's membership key. Raw registry
// names like `1_0x1c7D…` would produce ugly, near-length-limit tool names.
const sanitize = (raw: string): string => raw.replace(/[^A-Za-z0-9_]/g, "_");

export const resolveMcpServers = async (
  mcpNames: string[],
  bearerToken: string,
): Promise<McpServerEntry[]> => {
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl) throw new RegistryUnreachableError(new Error("REGISTRY_URL is unset"));

  if (mcpNames.length === 0) return [];

  let manifest: ManifestEntry[];
  try {
    const res = await fetch(`${registryUrl}/mcp`, { cache: "no-store" });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    manifest = (await res.json()) as ManifestEntry[];
  } catch (err) {
    throw new RegistryUnreachableError(err);
  }

  const byName = new Map(manifest.map((m) => [m.name, m]));

  // Deterministic for a given selection: the server name is also the bundle key, so the
  // dedupe suffixes must not depend on the order the client happened to send.
  const ordered = [...new Set(mcpNames)].sort();
  const used = new Set<string>();
  const entries: McpServerEntry[] = [];

  for (const mcpName of ordered) {
    const item = byName.get(mcpName);
    if (!item) throw new UnknownMcpError(mcpName);

    const base = sanitize(item.contractName?.trim() || mcpName) || "Mcp";
    let serverName = base;
    for (let n = 2; used.has(serverName); n += 1) serverName = `${base}_${n}`;
    used.add(serverName);

    // The manifest's `url` is a path (`/interface/<name>/mcp`), not an absolute URL — the
    // same join lib/registry-mcps.ts does for the catalog. REGISTRY_URL, not
    // PUBLIC_REGISTRY_URL: zeroclaw runs on the same host as the app.
    entries.push({
      mcpName,
      serverName,
      url: new URL(item.url, registryUrl).toString(),
      bearerToken,
    });
  }

  return entries;
};
