import { merkleRootOf } from './hash'
import type { MarketplacePointer, SkillsIndex } from './types'

/**
 * Read side of the marketplace: fetch content from 0G Storage by root hash and
 * prove locally that the bytes are what the index named.
 *
 * Deliberately no SDK on the read path. The indexer serves files over plain
 * HTTP (`GET /file?root=0x…`), so the only thing the 0G SDK is needed for is
 * recomputing the Merkle root — pure local computation, no network. That is
 * what makes a compromised or merely buggy gateway unable to inject content.
 */

export type GatewayErrorKind = 'unreachable' | 'verification'

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  constructor(kind: GatewayErrorKind, message: string, cause?: unknown) {
    super(message)
    this.name = 'GatewayError'
    this.kind = kind
    this.cause = cause
  }
}

export function fileUrl(indexerUrl: string, rootHash: string): string {
  return `${indexerUrl.replace(/\/+$/, '')}/file?root=${rootHash.toLowerCase()}`
}

export interface FetchVerifiedOptions {
  indexerUrl: string
  rootHash: string
  /** When known, checked before hashing — a cheap way to reject the obvious. */
  expectedSize?: number
  fetchImpl?: typeof fetch
}

export async function fetchVerified(opts: FetchVerifiedOptions): Promise<Uint8Array> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const url = fileUrl(opts.indexerUrl, opts.rootHash)

  let bytes: Uint8Array
  try {
    const res = await doFetch(url, { cache: 'no-store' })
    if (!res.ok) {
      throw new GatewayError('unreachable', `0G indexer responded ${res.status} for ${url}`)
    }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    // A verification failure raised inside the try must not be relabelled.
    if (err instanceof GatewayError) throw err
    throw new GatewayError('unreachable', `0G indexer unreachable at ${url}`, err)
  }

  if (opts.expectedSize !== undefined && bytes.length !== opts.expectedSize) {
    throw new GatewayError(
      'verification',
      `${opts.rootHash}: expected ${opts.expectedSize} bytes, got ${bytes.length}`,
    )
  }

  const actual = await merkleRootOf(bytes)
  if (actual.toLowerCase() !== opts.rootHash.toLowerCase()) {
    throw new GatewayError(
      'verification',
      `merkle root mismatch: expected ${opts.rootHash.toLowerCase()}, computed ${actual}`,
    )
  }

  return bytes
}

export interface FetchIndexOptions {
  pointer: MarketplacePointer
  /** Overrides the pointer's own indexer, for a mirror or a local gateway. */
  indexerUrl?: string
  fetchImpl?: typeof fetch
}

export async function fetchIndex(opts: FetchIndexOptions): Promise<SkillsIndex> {
  const { pointer } = opts
  const bytes = await fetchVerified({
    indexerUrl: opts.indexerUrl ?? pointer.network.indexerRpc,
    rootHash: pointer.indexRoot,
    expectedSize: pointer.indexSizeBytes,
    fetchImpl: opts.fetchImpl,
  })

  // Everything below is a 'verification' failure, never 'unreachable': the
  // bytes hashed to the root the pointer named, so the network did its job and
  // the publisher is the one at fault.
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
  } catch (err) {
    throw new GatewayError('verification', 'skills index is not valid JSON', err)
  }

  const index = parsed as SkillsIndex
  if (index?.schemaVersion !== 1) {
    throw new GatewayError(
      'verification',
      `skills index has unsupported schemaVersion ${String(index?.schemaVersion)}`,
    )
  }
  if (!Array.isArray(index.skills)) {
    throw new GatewayError('verification', 'skills index has no skills array')
  }

  return index
}
