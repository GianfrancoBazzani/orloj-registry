import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndex,
  serializeIndex,
  buildPointer,
  serializePointer,
  networkMismatch,
} from './index-file'
import type { HashedSkill } from './diff'
import type { SkillsIndex } from './types'

const MAINNET = { chainId: 16661, name: '0g-aristotle-mainnet' }
const NOW = '2026-07-26T12:00:00.000Z'
const enc = (s: string) => new TextEncoder().encode(s)

function hashed(name: string, contentHash: string): HashedSkill {
  return {
    name,
    description: `${name} description`,
    contentHash,
    sizeBytes: 10,
    files: [
      { path: 'SKILL.md', rootHash: '0xaaa', bytes: enc('x'), sizeBytes: 10 },
    ],
  }
}

test('builds an index with schemaVersion and network', () => {
  const idx = buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW)
  assert.equal(idx.schemaVersion, 1)
  assert.deepEqual(idx.network, MAINNET)
  assert.equal(idx.skills.length, 1)
  assert.equal(idx.skills[0]!.publishedAt, NOW)
})

test('sorts skills by name regardless of input order', () => {
  const idx = buildIndex(
    [hashed('zeta', '0xh2'), hashed('alpha', '0xh1')],
    MAINNET,
    null,
    NOW,
  )
  assert.deepEqual(
    idx.skills.map((s) => s.name),
    ['alpha', 'zeta'],
  )
})

test('preserves publishedAt when contentHash is unchanged', () => {
  const first = buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW)
  const later = buildIndex(
    [hashed('alpha', '0xh1')],
    MAINNET,
    first,
    '2027-01-01T00:00:00.000Z',
  )
  assert.equal(later.skills[0]!.publishedAt, NOW)
})

test('refreshes publishedAt when contentHash changes', () => {
  const first = buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW)
  const later = buildIndex(
    [hashed('alpha', '0xCHANGED')],
    MAINNET,
    first,
    '2027-01-01T00:00:00.000Z',
  )
  assert.equal(later.skills[0]!.publishedAt, '2027-01-01T00:00:00.000Z')
})

test('serialization is byte-identical for identical input', () => {
  const a = serializeIndex(buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW))
  const b = serializeIndex(buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW))
  assert.equal(a, b)
})

test('a no-op rebuild round-trips to identical bytes', () => {
  const first = buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW)
  const again = buildIndex(
    [hashed('alpha', '0xh1')],
    MAINNET,
    first,
    '2099-01-01T00:00:00.000Z',
  )
  assert.equal(serializeIndex(first), serializeIndex(again))
})

test('serialization uses two-space indent and a trailing newline', () => {
  const out = serializeIndex(buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW))
  assert.ok(out.endsWith('\n'))
  assert.match(out, /\n  "schemaVersion": 1,/)
})

test('key order matches the schema declaration order', () => {
  const out = serializeIndex(buildIndex([hashed('alpha', '0xh1')], MAINNET, null, NOW))
  const keys = [...out.matchAll(/^\s{4}"(\w+)":/gm)].map((m) => m[1])
  assert.deepEqual(keys.slice(0, 2), ['chainId', 'name'])
})

test('detects a network mismatch', () => {
  const committed: SkillsIndex = {
    schemaVersion: 1,
    network: { chainId: 16602, name: '0g-galileo-testnet' },
    skills: [],
  }
  assert.match(networkMismatch(committed, MAINNET)!, /galileo.*aristotle/s)
  assert.equal(networkMismatch(committed, committed.network), null)
  assert.equal(networkMismatch(null, MAINNET), null)
})

test('builds and serializes the pointer', () => {
  const p = buildPointer({
    indexRoot: '0xROOT',
    indexTxHash: '0xTX',
    indexSizeBytes: 100,
    skillCount: 7,
    publisher: '0xPUB',
    network: { ...MAINNET, indexerRpc: 'https://indexer.example' },
    publishedAt: NOW,
  })
  assert.equal(p.schemaVersion, 1)
  assert.equal(p.indexRoot, '0xroot')
  assert.equal(p.indexTxHash, '0xtx')
  assert.ok(serializePointer(p).endsWith('\n'))
})

test('buildPointer records the publishing wallet, lowercased', () => {
  const p = buildPointer({
    indexRoot: '0xAA',
    indexTxHash: '0xBB',
    indexSizeBytes: 1,
    skillCount: 1,
    publisher: '0xDCeb0C6598c28592f55d8CCF0bFDaA0A7B2012D8',
    network: { chainId: 16661, name: 'n', indexerRpc: 'https://i' },
    publishedAt: 'now',
  })
  assert.equal(p.publisher, '0xdceb0c6598c28592f55d8ccf0bfdaa0a7b2012d8')
})
