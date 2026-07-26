import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOg, formatBytes, formatManifest } from './manifest'
import { NETWORKS } from './networks'
import type { FilePlan } from './diff'

const enc = (s: string) => new TextEncoder().encode(s)

const plan = (path: string, status: FilePlan['status']): FilePlan => ({
  skill: 'alpha',
  path,
  rootHash: '0x' + 'a'.repeat(64),
  sizeBytes: 7303,
  status,
  bytes: enc('x'),
})

test('formats wei as 0G with nine decimals, truncating not rounding', () => {
  assert.equal(formatOg(0n), '0.000000000 0G')
  assert.equal(formatOg(891275703898n), '0.000000891 0G')
  assert.equal(formatOg(6208000000000n), '0.000006208 0G')
  // truncated, not rounded — the 18-decimal value ends ...187996545185
  assert.equal(formatOg(92225136187996545185n), '92.225136187 0G')
})

test('formats byte sizes readably', () => {
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(7303), '7.1 KB')
})

test('manifest names the network and signer', () => {
  const out = formatManifest({
    network: NETWORKS.mainnet,
    signer: '0xDCeb0C6598c28592f55d8CCF0bFDaA0A7B2012D8',
    balanceWei: 92225136187996545185n,
    estimatedFeeWei: 6208000000000n,
    files: [plan('SKILL.md', 'new')],
    safety: { refusals: [], warnings: [] },
    willUploadIndex: true,
    confirmed: false,
  })
  assert.match(out, /0g-aristotle-mainnet/)
  assert.match(out, /16661/)
  assert.match(out, /0xDCeb0C6598c28592f55d8CCF0bFDaA0A7B2012D8/)
})

test('manifest lists each file with its status', () => {
  const out = formatManifest({
    network: NETWORKS.testnet,
    signer: '0xabc',
    balanceWei: 10n ** 18n,
    estimatedFeeWei: 1n,
    files: [plan('SKILL.md', 'new'), plan('references/n.md', 'unchanged')],
    safety: { refusals: [], warnings: [] },
    willUploadIndex: true,
    confirmed: false,
  })
  assert.match(out, /SKILL\.md.*new/)
  assert.match(out, /references\/n\.md.*unchanged/)
})

test('manifest states the transaction count including the index', () => {
  const out = formatManifest({
    network: NETWORKS.testnet,
    signer: '0xabc',
    balanceWei: 10n ** 18n,
    estimatedFeeWei: 1n,
    files: [
      plan('SKILL.md', 'new'),
      plan('b.md', 'changed'),
      plan('c.md', 'unchanged'),
    ],
    safety: { refusals: [], warnings: [] },
    willUploadIndex: true,
    confirmed: false,
  })
  assert.match(out, /3 transactions/)
})

test('manifest says DRY RUN when not confirmed', () => {
  const out = formatManifest({
    network: NETWORKS.mainnet,
    signer: '0xabc',
    balanceWei: 1n,
    estimatedFeeWei: 1n,
    files: [plan('SKILL.md', 'new')],
    safety: { refusals: [], warnings: [] },
    willUploadIndex: true,
    confirmed: false,
  })
  assert.match(out, /DRY RUN/)
  assert.match(out, /--confirm/)
})

test('manifest surfaces safety warnings', () => {
  const out = formatManifest({
    network: NETWORKS.testnet,
    signer: '0xabc',
    balanceWei: 1n,
    estimatedFeeWei: 1n,
    files: [plan('SKILL.md', 'new')],
    safety: {
      refusals: [],
      warnings: ['alpha/SKILL.md: line 3 contains a 64-hex value'],
    },
    willUploadIndex: true,
    confirmed: false,
  })
  assert.match(out, /line 3 contains a 64-hex value/)
})

test('manifest reports a no-op when nothing needs uploading', () => {
  const out = formatManifest({
    network: NETWORKS.mainnet,
    signer: '0xabc',
    balanceWei: 1n,
    estimatedFeeWei: 0n,
    files: [plan('SKILL.md', 'unchanged')],
    safety: { refusals: [], warnings: [] },
    willUploadIndex: false,
    confirmed: true,
  })
  assert.match(out, /nothing to publish/i)
})
