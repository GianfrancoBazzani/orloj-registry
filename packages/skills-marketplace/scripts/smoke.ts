import 'dotenv/config'
import { resolveNetwork } from '../src/networks'
import { createZgClient } from '../src/zg'
import { merkleRootOf } from '../src/hash'
import { formatOg } from '../src/manifest'

// Read-only by default. Pass --upload to actually store a blob, which costs
// real 0G on mainnet and is permanent.
const args = process.argv.slice(2)
const netIdx = args.indexOf('--network')
const networkKey = netIdx === -1 ? 'mainnet' : args[netIdx + 1]
const doUpload = args.includes('--upload')

const network = resolveNetwork(networkKey, {
  rpcUrl: process.env.ZG_RPC_URL,
  indexerRpc: process.env.ZG_INDEXER_RPC,
})

const key = process.env.ZG_PRIVATE_KEY
if (!key) throw new Error('ZG_PRIVATE_KEY is not set')

const client = await createZgClient(network, key)
console.log('network        ', network.name, network.chainId)
console.log('signer         ', client.address)
console.log('balance        ', formatOg(await client.balance()))
console.log('pricePerSector ', await client.pricePerSector())

const payload = new TextEncoder().encode(
  `orloj smoke test ${args.find((a) => !a.startsWith('--')) ?? 'default'}\n`,
)

const expected = await merkleRootOf(payload)
console.log('local root     ', expected)
console.log('estimated fee  ', formatOg(await client.estimateFee([payload])))

if (!doUpload) {
  console.log('\nread-only check complete. Pass --upload to store a blob.')
  process.exit(0)
}

const uploaded = await client.uploadBlob(payload)
console.log('uploaded root  ', uploaded.rootHash)
console.log('tx             ', `${network.explorer}/tx/${uploaded.txHash}`)

if (uploaded.rootHash !== expected) {
  throw new Error(
    `ROOT MISMATCH: local ${expected} vs network ${uploaded.rootHash}`,
  )
}
console.log('local root matches network root')

const roundTripped = await client.downloadToBytes(uploaded.rootHash)
const same =
  roundTripped.length === payload.length &&
  roundTripped.every((b, i) => b === payload[i])
console.log(same ? 'download byte-identical' : 'DOWNLOAD MISMATCH')
if (!same) process.exit(1)
