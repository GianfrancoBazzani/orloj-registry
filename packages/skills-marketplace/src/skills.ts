import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface LocalFile {
  path: string
  bytes: Uint8Array
  sizeBytes: number
}

export interface LocalSkill {
  name: string
  description: string
  dir: string
  sizeBytes: number
  files: LocalFile[]
}

export class SkillValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`skill validation failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'SkillValidationError'
  }
}

/** Byte-stable string comparison. Never use localeCompare — it is locale-dependent. */
export const byString = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

function collectFiles(root: string, prefix = ''): LocalFile[] {
  const out: LocalFile[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = join(root, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, rel))
    } else if (entry.isFile()) {
      const bytes = new Uint8Array(readFileSync(abs))
      out.push({ path: rel.split(sep).join('/'), bytes, sizeBytes: bytes.length })
    }
  }
  return out
}

export function scanSkills(skillsDir: string): LocalSkill[] {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    throw new Error(`skills directory not found: ${skillsDir}`)
  }

  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(byString)

  if (dirs.length === 0) {
    throw new Error(`no skill directories found in ${skillsDir}`)
  }

  const problems: string[] = []
  const skills: LocalSkill[] = []

  for (const dirName of dirs) {
    const dir = join(skillsDir, dirName)
    const skillMd = join(dir, 'SKILL.md')

    if (!existsSync(skillMd)) {
      problems.push(`${dirName}: directory has no SKILL.md`)
      continue
    }

    const raw = readFileSync(skillMd, 'utf8')
    const match = FRONTMATTER_RE.exec(raw)
    if (!match) {
      problems.push(`${dirName}: SKILL.md has no YAML frontmatter block`)
      continue
    }

    let fm: unknown
    try {
      fm = parseYaml(match[1]!)
    } catch (e) {
      problems.push(
        `${dirName}: frontmatter is not valid YAML (${(e as Error).message})`,
      )
      continue
    }

    const meta = (fm ?? {}) as Record<string, unknown>
    const name = typeof meta.name === 'string' ? meta.name.trim() : ''
    const description =
      typeof meta.description === 'string' ? meta.description.trim() : ''

    if (!name) problems.push(`${dirName}: frontmatter is missing "name"`)
    if (!description) {
      problems.push(`${dirName}: frontmatter is missing "description"`)
    }
    if (name && name !== dirName) {
      problems.push(
        `${dirName}: frontmatter name "${name}" does not match the folder name`,
      )
    }

    const files = collectFiles(dir).sort((a, b) => byString(a.path, b.path))
    for (const f of files) {
      if (f.sizeBytes === 0) problems.push(`${dirName}: ${f.path} is empty`)
    }

    if (!name || !description || name !== dirName) continue

    skills.push({
      name,
      description,
      dir,
      files,
      sizeBytes: files.reduce((acc, f) => acc + f.sizeBytes, 0),
    })
  }

  if (problems.length > 0) throw new SkillValidationError(problems)
  return skills.sort((a, b) => byString(a.name, b.name))
}
