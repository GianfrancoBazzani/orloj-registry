import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merkleRootOf } from './hash'
import { fetchIndex, fetchVerified, fileUrl, GatewayError } from './gateway'
import type { MarketplacePointer, SkillsIndex } from './types'

const INDEXER = 'https://indexer.example'
const bytesOf = (s: string) => new TextEncoder().encode(s)

// A stub that always serves the same bytes with a 200.
const serves = (body: Uint8Array) =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch

const pointerFor = (root: string, size: number): MarketplacePointer => ({
  schemaVersion: 1,
  indexRoot: root,
  indexTxHash: '0x0',
  indexSizeBytes: size,
  skillCount: 0,
  publishedAt: 'now',
  network: { chainId: 16661, name: '0g-aristotle-mainnet', indexerRpc: INDEXER },
})

test('builds the documented gateway url', () => {
  assert.equal(fileUrl(INDEXER, '0xAB'), `${INDEXER}/file?root=0xab`)
  assert.equal(fileUrl(`${INDEXER}/`, '0xab'), `${INDEXER}/file?root=0xab`)
})

test('returns bytes whose merkle root matches', async () => {
  const body = bytesOf('hello skills')
  const root = await merkleRootOf(body)
  const got = await fetchVerified({ indexerUrl: INDEXER, rootHash: root, fetchImpl: serves(body) })
  assert.deepEqual(got, body)
})

test('accepts a root hash that differs only in case', async () => {
  const body = bytesOf('hello skills')
  const root = (await merkleRootOf(body)).toUpperCase().replace('0X', '0x')
  const got = await fetchVerified({ indexerUrl: INDEXER, rootHash: root, fetchImpl: serves(body) })
  assert.deepEqual(got, body)
})

test('rejects bytes whose merkle root does not match', async () => {
  const root = await merkleRootOf(bytesOf('expected'))
  await assert.rejects(
    fetchVerified({ indexerUrl: INDEXER, rootHash: root, fetchImpl: serves(bytesOf('tampered')) }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'verification',
  )
})

test('rejects a size mismatch before hashing', async () => {
  const body = bytesOf('abc')
  const root = await merkleRootOf(body)
  await assert.rejects(
    fetchVerified({
      indexerUrl: INDEXER,
      rootHash: root,
      expectedSize: 99,
      fetchImpl: serves(body),
    }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'verification',
  )
})

test('maps a non-200 to unreachable', async () => {
  await assert.rejects(
    fetchVerified({
      indexerUrl: INDEXER,
      rootHash: '0xab',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'unreachable',
  )
})

test('maps a thrown fetch to unreachable', async () => {
  await assert.rejects(
    fetchVerified({
      indexerUrl: INDEXER,
      rootHash: '0xab',
      fetchImpl: (async () => {
        throw new Error('dns')
      }) as unknown as typeof fetch,
    }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'unreachable',
  )
})

test('fetches and parses the index at the pointer root', async () => {
  const index: SkillsIndex = {
    schemaVersion: 1,
    network: { chainId: 16661, name: '0g-aristotle-mainnet' },
    skills: [],
  }
  const body = bytesOf(JSON.stringify(index))
  const root = await merkleRootOf(body)
  const got = await fetchIndex({
    pointer: pointerFor(root, body.length),
    fetchImpl: serves(body),
  })
  assert.deepEqual(got, index)
})

test('rejects an index with an unsupported schemaVersion', async () => {
  const body = bytesOf(JSON.stringify({ schemaVersion: 2, network: {}, skills: [] }))
  const root = await merkleRootOf(body)
  await assert.rejects(
    fetchIndex({ pointer: pointerFor(root, body.length), fetchImpl: serves(body) }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'verification',
  )
})

test('rejects an index that is not an object with a skills array', async () => {
  const body = bytesOf(JSON.stringify({ schemaVersion: 1, network: {}, skills: 'nope' }))
  const root = await merkleRootOf(body)
  await assert.rejects(
    fetchIndex({ pointer: pointerFor(root, body.length), fetchImpl: serves(body) }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'verification',
  )
})

test('verified-but-unparseable bytes are a verification failure, not unreachable', async () => {
  // The network did its job; the publisher shipped garbage.
  const body = bytesOf('{ not json')
  const root = await merkleRootOf(body)
  await assert.rejects(
    fetchIndex({ pointer: pointerFor(root, body.length), fetchImpl: serves(body) }),
    (e: GatewayError) => e instanceof GatewayError && e.kind === 'verification',
  )
})

test('an explicit indexerUrl overrides the pointer network', async () => {
  const body = bytesOf(JSON.stringify({ schemaVersion: 1, network: {}, skills: [] }))
  const root = await merkleRootOf(body)
  let seen = ''
  const spy = (async (url: string) => {
    seen = url
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  await fetchIndex({
    pointer: pointerFor(root, body.length),
    indexerUrl: 'https://other.example',
    fetchImpl: spy,
  })
  assert.ok(seen.startsWith('https://other.example/file?root='), seen)
})
