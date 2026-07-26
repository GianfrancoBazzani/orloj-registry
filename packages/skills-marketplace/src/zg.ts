import { Indexer, MemData, calculatePrice } from '@0gfoundation/0g-storage-ts-sdk'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import type { NetworkProfile } from './networks'

const MARKET_ABI = ['function pricePerSector() view returns (uint256)']

export interface UploadResult {
  rootHash: string
  txHash: string
}

export interface ZgClient {
  address: string
  balance(): Promise<bigint>
  pricePerSector(): Promise<bigint>
  estimateFee(blobs: Uint8Array[]): Promise<bigint>
  uploadBlob(bytes: Uint8Array): Promise<UploadResult>
  downloadToBytes(rootHash: string): Promise<Uint8Array>
}

export async function createZgClient(
  network: NetworkProfile,
  privateKey: string,
): Promise<ZgClient> {
  const provider = new JsonRpcProvider(network.rpcUrl)
  const wallet = new Wallet(privateKey, provider)
  const indexer = new Indexer(network.indexerRpc)

  const actual = (await provider.getNetwork()).chainId
  if (actual !== BigInt(network.chainId)) {
    throw new Error(
      `chain ID mismatch: ${network.rpcUrl} reports ${actual}, but the ` +
        `${network.key} profile expects ${network.chainId}`,
    )
  }

  let cachedPrice: bigint | undefined

  const pricePerSector = async (): Promise<bigint> => {
    if (cachedPrice !== undefined) return cachedPrice
    const [uploader, err] = await indexer.newUploaderFromIndexerNodes(
      network.rpcUrl,
      wallet,
      1,
    )
    if (err || !uploader) {
      throw new Error(
        `could not reach storage nodes: ${err?.message ?? 'unknown'}`,
      )
    }
    const marketAddress = await uploader.flow.market()
    const market = new Contract(marketAddress, MARKET_ABI, provider)
    // getFunction, not market.pricePerSector() — ethers v6 does not type
    // dynamically-attached ABI methods, so the direct call fails typecheck.
    cachedPrice = (await market.getFunction('pricePerSector')()) as bigint
    return cachedPrice
  }

  return {
    address: wallet.address,

    async balance() {
      return provider.getBalance(wallet.address)
    },

    pricePerSector,

    async estimateFee(blobs) {
      if (blobs.length === 0) return 0n
      const price = await pricePerSector()
      let total = 0n
      for (const bytes of blobs) {
        const [submission, err] = await new MemData(bytes).createSubmission('0x')
        if (err || !submission) {
          throw new Error(
            `fee estimate failed: ${err?.message ?? 'no submission'}`,
          )
        }
        total += calculatePrice(submission, price)
      }
      return total
    },

    async uploadBlob(bytes) {
      const [result, err] = await indexer.upload(
        new MemData(bytes),
        network.rpcUrl,
        wallet,
      )
      if (err) throw new Error(`upload failed: ${err.message}`)
      if ('rootHashes' in result) {
        throw new Error(
          'upload returned a fragmented result; the index schema assumes one root per file',
        )
      }
      return {
        rootHash: result.rootHash.toLowerCase(),
        txHash: result.txHash.toLowerCase(),
      }
    },

    async downloadToBytes(rootHash) {
      const [blob, err] = await indexer.downloadToBlob(rootHash)
      if (err) throw new Error(`download failed for ${rootHash}: ${err.message}`)
      return new Uint8Array(await blob.arrayBuffer())
    },
  }
}
