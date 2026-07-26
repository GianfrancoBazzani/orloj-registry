import { MemData } from '@0gfoundation/0g-storage-ts-sdk'
import { keccak256, toUtf8Bytes } from 'ethers'
import { byString } from './skills'

/**
 * The 0G Storage Merkle root of `bytes`, computed locally.
 * No network call — this is what lets us skip already-published files.
 */
export async function merkleRootOf(bytes: Uint8Array): Promise<string> {
  const [tree, err] = await new MemData(bytes).merkleTree()
  if (err) throw new Error(`failed to build Merkle tree: ${err.message}`)
  const root = tree?.rootHash()
  if (!root) throw new Error('Merkle tree produced no root hash')
  return root.toLowerCase()
}

/**
 * Identity of a skill: keccak256 over its sorted "path:rootHash" lines.
 * Order-independent because the lines are sorted before hashing.
 */
export function contentHashOf(
  files: { path: string; rootHash: string }[],
): string {
  const body = [...files]
    .sort((a, b) => byString(a.path, b.path))
    .map((f) => `${f.path}:${f.rootHash.toLowerCase()}`)
    .join('\n')
  return keccak256(toUtf8Bytes(body)).toLowerCase()
}
