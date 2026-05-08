import { mainnet, sepolia, type Chain } from "viem/chains";

export interface ChainEntry {
  chain: Chain;
  defaultRpc: string;
}

export const SUPPORTED_CHAINS = {
  mainnet: {
    chain: mainnet,
    defaultRpc: "https://eth.llamarpc.com",
  },
  sepolia: {
    chain: sepolia,
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  },
} as const satisfies Record<string, ChainEntry>;

export type SupportedChainKey = keyof typeof SUPPORTED_CHAINS;

const DEFAULT_ENS_CHAIN: SupportedChainKey = "mainnet";

const isSupported = (key: string): key is SupportedChainKey =>
  key in SUPPORTED_CHAINS;

export const resolveEnsChain = (): {
  key: SupportedChainKey;
  chain: Chain;
  rpcUrl: string;
} => {
  const requested = (process.env.ENS_CHAIN ?? DEFAULT_ENS_CHAIN).toLowerCase();
  if (!isSupported(requested)) {
    const supported = Object.keys(SUPPORTED_CHAINS).join(", ");
    throw new Error(
      `ENS_CHAIN="${requested}" is not supported. Add it to SUPPORTED_CHAINS in lib/chains.ts. Currently supported: ${supported}.`,
    );
  }
  const entry = SUPPORTED_CHAINS[requested];
  const perChainEnv = `ETH_RPC_URL_${requested.toUpperCase()}`;
  const rpcUrl =
    process.env[perChainEnv] ?? process.env.ETH_RPC_URL ?? entry.defaultRpc;
  return { key: requested, chain: entry.chain, rpcUrl };
};
