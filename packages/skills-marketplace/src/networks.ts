export type NetworkKey = 'mainnet' | 'testnet'

export interface NetworkProfile {
  key: NetworkKey
  name: string
  chainId: number
  rpcUrl: string
  indexerRpc: string
  explorer: string
  storageExplorer: string
  faucet?: string
  requiresTypedConfirmation: boolean
  confirmationWord?: string
}

export const NETWORKS: Record<NetworkKey, NetworkProfile> = {
  mainnet: {
    key: 'mainnet',
    name: '0g-aristotle-mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    indexerRpc: 'https://indexer-storage-turbo.0g.ai',
    explorer: 'https://chainscan.0g.ai',
    storageExplorer: 'https://storagescan.0g.ai',
    requiresTypedConfirmation: true,
    confirmationWord: 'aristotle',
  },
  testnet: {
    key: 'testnet',
    name: '0g-galileo-testnet',
    chainId: 16602,
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    indexerRpc: 'https://indexer-storage-testnet-turbo.0g.ai',
    explorer: 'https://chainscan-galileo.0g.ai',
    storageExplorer: 'https://storagescan-galileo.0g.ai',
    faucet: 'https://faucet.0g.ai',
    requiresTypedConfirmation: false,
  },
}

export interface EndpointOverrides {
  rpcUrl?: string
  indexerRpc?: string
}

export function resolveNetwork(
  key: string = 'mainnet',
  overrides: EndpointOverrides = {},
): NetworkProfile {
  const profile = NETWORKS[key as NetworkKey]
  if (!profile) {
    throw new Error(`unknown network "${key}". Valid values: mainnet, testnet`)
  }
  return {
    ...profile,
    rpcUrl: overrides.rpcUrl || profile.rpcUrl,
    indexerRpc: overrides.indexerRpc || profile.indexerRpc,
  }
}
