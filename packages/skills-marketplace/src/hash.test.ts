import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merkleRootOf, contentHashOf } from './hash'

const enc = (s: string) => new TextEncoder().encode(s)

test('merkle root is lowercase 0x-prefixed hex', async () => {
  const root = await merkleRootOf(enc('hello 0G'))
  assert.match(root, /^0x[0-9a-f]{64}$/)
})

test('merkle root is stable across calls for identical bytes', async () => {
  const a = await merkleRootOf(enc('same content'))
  const b = await merkleRootOf(enc('same content'))
  assert.equal(a, b)
})

test('merkle root differs for different bytes', async () => {
  const a = await merkleRootOf(enc('content A'))
  const b = await merkleRootOf(enc('content B'))
  assert.notEqual(a, b)
})

test('merkle root handles multi-segment data', async () => {
  const big = new Uint8Array(600 * 1024).fill(7)
  const root = await merkleRootOf(big)
  assert.match(root, /^0x[0-9a-f]{64}$/)
})

test('contentHash is independent of input order', () => {
  const a = contentHashOf([
    { path: 'SKILL.md', rootHash: '0xaa' },
    { path: 'references/x.md', rootHash: '0xbb' },
  ])
  const b = contentHashOf([
    { path: 'references/x.md', rootHash: '0xbb' },
    { path: 'SKILL.md', rootHash: '0xaa' },
  ])
  assert.equal(a, b)
})

test('contentHash changes when a root changes', () => {
  const a = contentHashOf([{ path: 'SKILL.md', rootHash: '0xaa' }])
  const b = contentHashOf([{ path: 'SKILL.md', rootHash: '0xab' }])
  assert.notEqual(a, b)
})

test('contentHash changes when a path changes', () => {
  const a = contentHashOf([{ path: 'SKILL.md', rootHash: '0xaa' }])
  const b = contentHashOf([{ path: 'OTHER.md', rootHash: '0xaa' }])
  assert.notEqual(a, b)
})

test('contentHash is lowercase 0x hex and case-insensitive on input', () => {
  const a = contentHashOf([{ path: 'SKILL.md', rootHash: '0xAABB' }])
  const b = contentHashOf([{ path: 'SKILL.md', rootHash: '0xaabb' }])
  assert.equal(a, b)
  assert.match(a, /^0x[0-9a-f]{64}$/)
})
