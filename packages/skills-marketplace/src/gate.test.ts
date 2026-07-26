import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { needsTypedConfirmation, promptForWord } from './gate'
import { NETWORKS } from './networks'

test('mainnet with --confirm needs a typed word', () => {
  assert.equal(needsTypedConfirmation(NETWORKS.mainnet, true), true)
})

test('mainnet without --confirm needs nothing (dry run)', () => {
  assert.equal(needsTypedConfirmation(NETWORKS.mainnet, false), false)
})

test('testnet never needs a typed word', () => {
  assert.equal(needsTypedConfirmation(NETWORKS.testnet, true), false)
})

test('accepts the exact word, trimmed and case-insensitive', async () => {
  for (const typed of ['aristotle\n', '  aristotle  \n', 'ARISTOTLE\n']) {
    const input = new PassThrough()
    const output = new PassThrough()
    const p = promptForWord('aristotle', input, output)
    input.write(typed)
    assert.equal(await p, true)
  }
})

test('rejects the wrong word', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const p = promptForWord('aristotle', input, output)
  input.write('galileo\n')
  assert.equal(await p, false)
})

test('rejects an empty line', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const p = promptForWord('aristotle', input, output)
  input.write('\n')
  assert.equal(await p, false)
})
