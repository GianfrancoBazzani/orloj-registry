import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlags, loadConfig } from './config'

const KEY = '0x' + '11'.repeat(32)

test('defaults: mainnet, not confirmed, nothing forced', () => {
  const f = parseFlags([])
  assert.equal(f.network, 'mainnet')
  assert.equal(f.confirm, false)
  assert.equal(f.force, false)
  assert.equal(f.allowNetworkSwitch, false)
  assert.equal(f.only, undefined)
})

test('parses every flag and composes them', () => {
  const f = parseFlags([
    '--network',
    'testnet',
    '--confirm',
    '--only',
    'fire-calculator',
    '--force',
    '--allow-network-switch',
  ])
  assert.deepEqual(f, {
    network: 'testnet',
    confirm: true,
    only: 'fire-calculator',
    force: true,
    allowNetworkSwitch: true,
  })
})

test('--network with no value is rejected', () => {
  assert.throws(() => parseFlags(['--network']), /requires a value/)
})

test('unknown flags are rejected rather than ignored', () => {
  assert.throws(() => parseFlags(['--yolo']), /unknown flag/)
})

test('loadConfig requires a private key', () => {
  assert.throws(() => loadConfig([], {}, '/pkg'), /ZG_PRIVATE_KEY/)
})

test('loadConfig rejects a malformed private key', () => {
  assert.throws(
    () => loadConfig([], { ZG_PRIVATE_KEY: 'nope' }, '/pkg'),
    /ZG_PRIVATE_KEY/,
  )
})

test('loadConfig resolves paths and applies endpoint overrides', () => {
  const c = loadConfig(
    ['--network', 'testnet'],
    { ZG_PRIVATE_KEY: KEY, ZG_RPC_URL: 'https://x.example' },
    '/pkg',
  )
  assert.equal(c.network.chainId, 16602)
  assert.equal(c.network.rpcUrl, 'https://x.example')
  assert.equal(c.skillsDir, '/pkg/skills')
  assert.equal(c.indexPath, '/pkg/skills-index.json')
  assert.equal(c.pointerPath, '/pkg/marketplace.json')
})
