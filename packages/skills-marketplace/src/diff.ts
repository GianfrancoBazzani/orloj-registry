import type { SkillsIndex } from './types'
import type { LocalFile } from './skills'

export type FileStatus = 'new' | 'changed' | 'unchanged'

export interface HashedFile extends LocalFile {
  rootHash: string
}

export interface HashedSkill {
  name: string
  description: string
  contentHash: string
  sizeBytes: number
  files: HashedFile[]
}

export interface FilePlan {
  skill: string
  path: string
  rootHash: string
  sizeBytes: number
  status: FileStatus
  bytes: Uint8Array
}

export interface DiffResult {
  files: FilePlan[]
  toUpload: FilePlan[]
}

export interface DiffOptions {
  force: boolean
  networkSwitch: boolean
}

export function diffSkills(
  hashed: HashedSkill[],
  committed: SkillsIndex | null,
  opts: DiffOptions,
): DiffResult {
  const known = new Map<string, string>()
  if (committed && !opts.networkSwitch) {
    for (const skill of committed.skills) {
      for (const file of skill.files) {
        known.set(`${skill.name}/${file.path}`, file.rootHash.toLowerCase())
      }
    }
  }

  const files: FilePlan[] = []

  for (const skill of hashed) {
    for (const file of skill.files) {
      const key = `${skill.name}/${file.path}`
      const previous = known.get(key)
      const root = file.rootHash.toLowerCase()

      let status: FileStatus
      if (opts.force || opts.networkSwitch || previous === undefined) {
        status = 'new'
      } else if (previous === root) {
        status = 'unchanged'
      } else {
        status = 'changed'
      }

      files.push({
        skill: skill.name,
        path: file.path,
        rootHash: root,
        sizeBytes: file.sizeBytes,
        status,
        bytes: file.bytes,
      })
    }
  }

  return { files, toUpload: files.filter((f) => f.status !== 'unchanged') }
}
