export const SHORT_ADDR = (a: string): string => a.slice(0, 6) + "…" + a.slice(-4);

// Display-safe name: shortens 0x… addresses, takes the local part of an email,
// and truncates anything else past `max` chars with an ellipsis.
export const SHORT_NAME = (name: string, max = 18): string => {
  if (!name) return "";
  if (/^0x[a-fA-F0-9]{40}$/.test(name)) return SHORT_ADDR(name);
  const at = name.indexOf("@");
  const base = at > 0 ? name.slice(0, at) : name;
  return base.length > max ? base.slice(0, max - 1) + "…" : base;
};

export interface Mcp {
  id: string;
  name: string;
  author: string;
  summary: string;
  chain: string;
  chainId: number;
  contract: string;
  mcpUrl: string;
  tags: string[];
  interfaces: number;
  callsLast24h: number;
  audited: boolean;
  audits: string[];
  verified: boolean;
  stars: number;
  color: string;
}

export type VaultProviderId = "oneclaw" | "orbitport";

export interface Vault {
  id: string;
  name: string;
  description: string;
  keyCount: number;
  provider: VaultProviderId;
  address?: string;
}

export interface Agent {
  id: string;
  name: string;
  vault: string;
  vaultId?: string;
  grantId?: string;
  keyPath?: string;
  mcps: string[];
  status: string;
  runs: number;
  lastRun: string;
}

export const MCP_REGISTRY: Mcp[] = [
  {
    id: "uniswap-v4-mcp", name: "Uniswap v4 Conductor", author: "uniswap.eth",
    summary: "Pool routing, liquidity provisioning, and hook orchestration as natural-language tools.",
    chain: "Ethereum", chainId: 1, contract: "0x000000000022D473030F116dDEE9F6B43aC78BA3", mcpUrl: "",
    tags: ["DEX", "Routing", "AMM"], interfaces: 14, callsLast24h: 184_322,
    audited: true, audits: ["Trail of Bits", "OpenZeppelin"], verified: true, stars: 2348, color: "verdigris",
  },
  {
    id: "aave-vault", name: "Aave Treasury Pilot", author: "aave.eth",
    summary: "Supply, borrow, repay, and rebalance positions across Aave v3 markets through a single interface.",
    chain: "Multichain", chainId: 0, contract: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", mcpUrl: "",
    tags: ["Lending", "Yield", "Vaults"], interfaces: 8, callsLast24h: 92_104,
    audited: true, audits: ["Certora"], verified: true, stars: 1602, color: "brass",
  },
  {
    id: "ens-tools", name: "ENS Resolver Mason", author: "nick.eth",
    summary: "Name resolution, reverse lookup, and text record inspection. Read-only by default.",
    chain: "Ethereum", chainId: 1, contract: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85", mcpUrl: "",
    tags: ["Identity", "Read-only"], interfaces: 6, callsLast24h: 410_823,
    audited: true, audits: ["ENS Labs"], verified: true, stars: 982, color: "blue",
  },
  {
    id: "safe-multisig", name: "Safe Council Atelier", author: "safe.eth",
    summary: "Compose, propose, and co-sign Safe multisig transactions. Built-in policy guardrails.",
    chain: "Multichain", chainId: 0, contract: "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA", mcpUrl: "",
    tags: ["Multisig", "Governance"], interfaces: 11, callsLast24h: 28_440,
    audited: true, audits: ["Ackee"], verified: true, stars: 1140, color: "verdigris",
  },
  {
    id: "lido-stake", name: "Lido Stake Foundry", author: "lido.eth",
    summary: "stETH/wstETH minting, withdrawals queue, and validator delegation operations.",
    chain: "Ethereum", chainId: 1, contract: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", mcpUrl: "",
    tags: ["Staking", "LST"], interfaces: 5, callsLast24h: 64_211,
    audited: true, audits: ["MixBytes", "Statemind"], verified: true, stars: 760, color: "wine",
  },
  {
    id: "farcaster-cast", name: "Farcaster Cast Loom", author: "dwr.eth",
    summary: "Read casts, react, follow, and publish through a structured tool surface.",
    chain: "Optimism", chainId: 10, contract: "0x00000000fc6c5F01Fc30151999387Bb99A9f489b", mcpUrl: "",
    tags: ["Social", "Content"], interfaces: 9, callsLast24h: 240_002,
    audited: false, audits: [], verified: true, stars: 538, color: "brass",
  },
  {
    id: "op-bridge", name: "Optimism Bridge Wagon", author: "op.eth",
    summary: "Deposit, withdraw, and prove cross-domain messages with safety windows surfaced as tool args.",
    chain: "Optimism", chainId: 10, contract: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1", mcpUrl: "",
    tags: ["Bridge", "L2"], interfaces: 4, callsLast24h: 14_320,
    audited: true, audits: ["Sigma Prime"], verified: true, stars: 412, color: "blue",
  },
  {
    id: "curve-pools", name: "Curve Stable Cellar", author: "curve.eth",
    summary: "Stablecoin & LSD pool routes with slippage policy. Returns gas-aware quotes.",
    chain: "Ethereum", chainId: 1, contract: "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC", mcpUrl: "",
    tags: ["DEX", "Stables"], interfaces: 7, callsLast24h: 88_121,
    audited: true, audits: ["ChainSecurity"], verified: false, stars: 314, color: "verdigris",
  },
  {
    id: "gnosis-pay", name: "Gnosis Pay Conductor", author: "gnosis.eth",
    summary: "Card spend limits, merchant whitelists, and per-agent allowance scopes.",
    chain: "Gnosis", chainId: 100, contract: "0x4Ecaba5870353805a9F068101A40E0f32ed605C6", mcpUrl: "",
    tags: ["Payments", "Cards"], interfaces: 6, callsLast24h: 7_240,
    audited: false, audits: [], verified: false, stars: 122, color: "wine",
  },
  {
    id: "ssv-validator", name: "SSV Validator Choir", author: "ssv.eth",
    summary: "Distributed validator key registration and operator selection orchestration.",
    chain: "Ethereum", chainId: 1, contract: "0xDD9BC35aE942eF0cFa76930954a156B3fF30a4E1", mcpUrl: "",
    tags: ["Staking", "DVT"], interfaces: 5, callsLast24h: 3_104,
    audited: true, audits: ["Hashlock"], verified: true, stars: 88, color: "verdigris",
  },
  {
    id: "morpho-blue", name: "Morpho Blue Forge", author: "morpho.eth",
    summary: "Permissionless markets — IRMs, oracles, LLTVs surfaced for agent orchestration.",
    chain: "Ethereum", chainId: 1, contract: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", mcpUrl: "",
    tags: ["Lending", "Markets"], interfaces: 12, callsLast24h: 51_902,
    audited: true, audits: ["Spearbit", "Cantina"], verified: true, stars: 1030, color: "brass",
  },
  {
    id: "snapshot-vote", name: "Snapshot Quill", author: "snapshot.eth",
    summary: "Off-chain governance vote casting and proposal drafting with delegate-aware power lookup.",
    chain: "Ethereum", chainId: 1, contract: "0x57b1F3673239DC1B69dC72fC92ed5dF66e10cab1", mcpUrl: "",
    tags: ["Governance", "Off-chain"], interfaces: 4, callsLast24h: 18_220,
    audited: false, audits: [], verified: true, stars: 410, color: "blue",
  },
];

export const USER_AGENTS: Agent[] = [];
