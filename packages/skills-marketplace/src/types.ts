export interface IndexedFile {
  path: string
  rootHash: string
  sizeBytes: number
}

export interface IndexedSkill {
  name: string
  description: string
  contentHash: string
  sizeBytes: number
  publishedAt: string
  files: IndexedFile[]
}

export interface IndexNetwork {
  chainId: number
  name: string
}

export interface SkillsIndex {
  schemaVersion: 1
  network: IndexNetwork
  skills: IndexedSkill[]
}

export interface PointerNetwork extends IndexNetwork {
  indexerRpc: string
}

export interface MarketplacePointer {
  schemaVersion: 1
  indexRoot: string
  indexTxHash: string
  /**
   * The wallet that uploaded the index, lowercased. Optional so a pointer
   * committed before this field existed still parses. Consumers use it to link
   * <https://storagescan.0g.ai/address/{publisher}>, which is the only
   * StorageScan view that lists a publisher's files — there is no working
   * per-root-hash URL.
   */
  publisher?: string
  indexSizeBytes: number
  skillCount: number
  network: PointerNetwork
  publishedAt: string
}
