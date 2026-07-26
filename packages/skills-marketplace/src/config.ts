import { join } from 'node:path'
import { resolveNetwork, type NetworkProfile } from './networks'

export interface Flags {
  network: string
  confirm: boolean
  only?: string
  force: boolean
  allowNetworkSwitch: boolean
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    network: 'mainnet',
    confirm: false,
    force: false,
    allowNetworkSwitch: false,
  }

  const needsValue = (i: number, name: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${name} requires a value`)
    }
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--network':
        flags.network = needsValue(i, '--network')
        i++
        break
      case '--only':
        flags.only = needsValue(i, '--only')
        i++
        break
      case '--confirm':
        flags.confirm = true
        break
      case '--force':
        flags.force = true
        break
      case '--allow-network-switch':
        flags.allowNetworkSwitch = true
        break
      default:
        throw new Error(`unknown flag "${arg}"`)
    }
  }

  return flags
}

export interface Config {
  flags: Flags
  network: NetworkProfile
  privateKey: string
  packageDir: string
  skillsDir: string
  indexPath: string
  pointerPath: string
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

export function loadConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  packageDir: string,
): Config {
  const flags = parseFlags(argv)

  const privateKey = env.ZG_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'ZG_PRIVATE_KEY is not set. Copy .env.example to .env and fill it in.',
    )
  }
  if (!PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error('ZG_PRIVATE_KEY must be 0x followed by 64 hex characters.')
  }

  const network = resolveNetwork(flags.network, {
    rpcUrl: env.ZG_RPC_URL,
    indexerRpc: env.ZG_INDEXER_RPC,
  })

  return {
    flags,
    network,
    privateKey,
    packageDir,
    skillsDir: join(packageDir, 'skills'),
    indexPath: join(packageDir, 'skills-index.json'),
    pointerPath: join(packageDir, 'marketplace.json'),
  }
}
