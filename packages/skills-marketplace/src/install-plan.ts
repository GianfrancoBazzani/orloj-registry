import type { IndexedSkill } from './types'
import { byString } from './skills'

/**
 * Pure planning for installing skills into an agent workspace.
 *
 * Nothing here touches the filesystem or the network. That is the point: the
 * index is whatever the publishing key uploaded to 0G, so every rule that
 * decides what may be written into a directory the agent reads lives in one
 * testable place.
 */

/** Lowercase, hyphen-separated. Also the on-disk directory name. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Mirrors MAX_MCPS in the app's session layer. */
export const MAX_SKILLS = 16
export const MAX_FILES_PER_SKILL = 32
export const MAX_SKILL_BYTES = 1024 * 1024
export const MAX_PATH_DEPTH = 4

const FILE_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

export class SkillPlanError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`skill selection rejected:\n  - ${problems.join('\n  - ')}`)
    this.name = 'SkillPlanError'
    this.problems = problems
  }
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

/**
 * Problems with a skill's declared files, or an empty array when it is fine.
 *
 * The regex alone already forbids a separator inside a segment, so the explicit
 * segment checks below are redundant today. They stay because they are what
 * turns a future loosening of the regex into a loud failure instead of a silent
 * path escape.
 */
export function validateSkillFiles(skill: IndexedSkill): string[] {
  const problems: string[] = []
  const where = (p: string) => `${skill.name}/${p}`

  if (skill.files.length === 0) {
    problems.push(`${skill.name}: declares no files`)
  }
  if (skill.files.length > MAX_FILES_PER_SKILL) {
    problems.push(
      `${skill.name}: declares ${skill.files.length} files, over the ${MAX_FILES_PER_SKILL}-files cap`,
    )
  }

  const total = skill.files.reduce((acc, f) => acc + f.sizeBytes, 0)
  if (total > MAX_SKILL_BYTES) {
    problems.push(
      `${skill.name}: declares ${total} bytes, over the ${MAX_SKILL_BYTES}-bytes cap`,
    )
  }

  for (const file of skill.files) {
    const p = file.path
    if (!FILE_PATH_RE.test(p)) {
      problems.push(`${where(p)}: path is not a plain relative path`)
      continue
    }
    const segments = p.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      problems.push(`${where(p)}: path contains a traversal segment`)
      continue
    }
    if (segments.length > MAX_PATH_DEPTH) {
      problems.push(`${where(p)}: path is ${segments.length} deep, over the ${MAX_PATH_DEPTH} cap`)
      continue
    }
    if (file.sizeBytes < 0) problems.push(`${where(p)}: negative size`)
  }

  // Without it zeroclaw does not recognise the directory as a skill at all.
  if (!skill.files.some((f) => f.path === 'SKILL.md')) {
    problems.push(`${skill.name}: has no SKILL.md at its root`)
  }

  return problems
}

export interface InstallPlan {
  /** Skills to download and write. Excludes those already on disk. */
  install: IndexedSkill[]
  /** Directory names to delete from the workspace. */
  remove: string[]
  /** Already-installed names that stay. */
  keep: string[]
  /** Requested names the index does not publish. Reported, not fatal. */
  dropped: string[]
}

export function planInstall(args: {
  requested: string[]
  installed: string[]
  index: IndexedSkill[]
}): InstallPlan {
  const requested = [...new Set(args.requested)]

  if (requested.length > MAX_SKILLS) {
    throw new SkillPlanError([
      `selection has ${requested.length} skills, over the ${MAX_SKILLS} cap`,
    ])
  }

  const badNames = requested.filter((n) => !isValidSkillName(n))
  if (badNames.length > 0) {
    throw new SkillPlanError(badNames.map((n) => `${JSON.stringify(n)}: not a valid skill name`))
  }

  const published = new Map(args.index.map((s) => [s.name, s]))
  const wanted: IndexedSkill[] = []
  const dropped: string[] = []
  for (const name of requested) {
    const found = published.get(name)
    if (found) wanted.push(found)
    else dropped.push(name)
  }

  // Only what we are about to write is validated. A hostile entry already on
  // disk must stay removable — validating it here would make the only way out
  // of a bad install impossible to take.
  const problems = wanted.flatMap(validateSkillFiles)
  if (problems.length > 0) throw new SkillPlanError(problems)

  const installedSet = new Set(args.installed)
  const wantedSet = new Set(wanted.map((s) => s.name))

  return {
    install: wanted.filter((s) => !installedSet.has(s.name)),
    remove: args.installed.filter((n) => !wantedSet.has(n)).sort(byString),
    keep: wanted.filter((s) => installedSet.has(s.name)).map((s) => s.name).sort(byString),
    dropped: dropped.sort(byString),
  }
}
