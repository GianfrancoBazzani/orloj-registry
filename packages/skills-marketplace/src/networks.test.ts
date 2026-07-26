import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveNetwork, NETWORKS } from './networks'

test('defaults to Aristotle mainnet', () => {
  const n = resolveNetwork()
  assert.equal(n.key, 'mainnet')
  assert.equal(n.chainId, 16661)
  assert.equal(n.name, '0g-aristotle-mainnet')
  assert.equal(n.requiresTypedConfirmation, true)
  assert.equal(n.confirmationWord, 'aristotle')
})

test('resolves Galileo testnet and needs no typed confirmation', () => {
  const n = resolveNetwork('testnet')
  assert.equal(n.chainId, 16602)
  assert.equal(n.name, '0g-galileo-testnet')
  assert.equal(n.requiresTypedConfirmation, false)
})

test('rejects an unknown network name listing valid values', () => {
  assert.throws(() => resolveNetwork('goerli'), /mainnet.*testnet/)
})

test('overrides replace endpoints but never the chain ID', () => {
  const n = resolveNetwork('mainnet', {
    rpcUrl: 'https://private.example/rpc',
    indexerRpc: 'https://private.example/indexer',
  })
  assert.equal(n.rpcUrl, 'https://private.example/rpc')
  assert.equal(n.indexerRpc, 'https://private.example/indexer')
  assert.equal(n.chainId, 16661)
})

test('empty overrides do not blank out profile endpoints', () => {
  const n = resolveNetwork('mainnet', { rpcUrl: undefined, indexerRpc: '' })
  assert.equal(n.rpcUrl, NETWORKS.mainnet.rpcUrl)
  assert.equal(n.indexerRpc, NETWORKS.mainnet.indexerRpc)
})
