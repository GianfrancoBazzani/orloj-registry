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
  indexSizeBytes: number
  skillCount: number
  network: PointerNetwork
  publishedAt: string
}
