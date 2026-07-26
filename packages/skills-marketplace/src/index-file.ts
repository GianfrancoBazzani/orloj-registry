import { existsSync, readFileSync } from 'node:fs'
import type {
  IndexNetwork,
  IndexedSkill,
  MarketplacePointer,
  PointerNetwork,
  SkillsIndex,
} from './types'
import type { HashedSkill } from './diff'
import { byString } from './skills'

export function buildIndex(
  hashed: HashedSkill[],
  network: IndexNetwork,
  committed: SkillsIndex | null,
  now: string,
): SkillsIndex {
  const previous = new Map<string, IndexedSkill>()
  for (const s of committed?.skills ?? []) previous.set(s.name, s)

  const skills: IndexedSkill[] = hashed
    .map((s) => {
      const before = previous.get(s.name)
      const unchanged =
        before !== undefined &&
        before.contentHash.toLowerCase() === s.contentHash.toLowerCase()

      return {
        name: s.name,
        description: s.description,
        contentHash: s.contentHash.toLowerCase(),
        sizeBytes: s.sizeBytes,
        publishedAt: unchanged ? before.publishedAt : now,
        files: [...s.files]
          .sort((a, b) => byString(a.path, b.path))
          .map((f) => ({
            path: f.path,
            rootHash: f.rootHash.toLowerCase(),
            sizeBytes: f.sizeBytes,
          })),
      }
    })
    .sort((a, b) => byString(a.name, b.name))

  return { schemaVersion: 1, network, skills }
}

export function serializeIndex(index: SkillsIndex): string {
  return JSON.stringify(index, null, 2) + '\n'
}

export function readCommittedIndex(path: string): SkillsIndex | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SkillsIndex
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `${path}: unsupported schemaVersion ${String(parsed.schemaVersion)}`,
    )
  }
  return parsed
}

export function networkMismatch(
  committed: SkillsIndex | null,
  target: IndexNetwork,
): string | null {
  if (!committed) return null
  if (committed.network.chainId === target.chainId) return null
  return (
    `the committed index was published to ${committed.network.name} ` +
    `(chainId ${committed.network.chainId}), but the target is ${target.name} ` +
    `(chainId ${target.chainId}). Roots from one network are meaningless on the ` +
    `other. Re-run with --allow-network-switch to republish everything.`
  )
}

export interface PointerArgs {
  indexRoot: string
  indexTxHash: string
  indexSizeBytes: number
  skillCount: number
  network: PointerNetwork
  publishedAt: string
}

export function buildPointer(args: PointerArgs): MarketplacePointer {
  return {
    schemaVersion: 1,
    indexRoot: args.indexRoot.toLowerCase(),
    indexTxHash: args.indexTxHash.toLowerCase(),
    indexSizeBytes: args.indexSizeBytes,
    skillCount: args.skillCount,
    network: args.network,
    publishedAt: args.publishedAt,
  }
}

export function serializePointer(pointer: MarketplacePointer): string {
  return JSON.stringify(pointer, null, 2) + '\n'
}
