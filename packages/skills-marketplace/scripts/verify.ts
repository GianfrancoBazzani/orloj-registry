import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NETWORKS, resolveNetwork, type NetworkKey } from '../src/networks'
import { readCommittedIndex } from '../src/index-file'
import { createZgClient } from '../src/zg'

const packageDir = join(import.meta.dirname, '..')
const index = readCommittedIndex(join(packageDir, 'skills-index.json'))
if (!index) {
  console.error('no skills-index.json yet — run publish:skills first')
  process.exit(1)
}

const flagIdx = process.argv.indexOf('--network')
const explicit = flagIdx === -1 ? undefined : process.argv[flagIdx + 1]
const fromIndex = (Object.keys(NETWORKS) as NetworkKey[]).find(
  (k) => NETWORKS[k].chainId === index.network.chainId,
)
const network = resolveNetwork(explicit ?? fromIndex ?? 'mainnet', {
  rpcUrl: process.env.ZG_RPC_URL,
  indexerRpc: process.env.ZG_INDEXER_RPC,
})

const key = process.env.ZG_PRIVATE_KEY
if (!key) {
  console.error('ZG_PRIVATE_KEY is not set')
  process.exit(1)
}

const client = await createZgClient(network, key)
console.log(`verifying against ${network.name} (chainId ${network.chainId})\n`)

let failures = 0
for (const skill of index.skills) {
  for (const file of skill.files) {
    const label = `${skill.name}/${file.path}`
    const local = new Uint8Array(
      readFileSync(join(packageDir, 'skills', skill.name, file.path)),
    )
    try {
      const remote = await client.downloadToBytes(file.rootHash)
      const same =
        remote.length === local.length && remote.every((b, i) => b === local[i])
      console.log(`  ${same ? 'ok  ' : 'FAIL'}  ${label}`)
      if (!same) failures++
    } catch (e) {
      console.log(`  FAIL  ${label} — ${(e as Error).message}`)
      failures++
    }
  }
}

console.log(failures === 0 ? '\nall files verified' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
