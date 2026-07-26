import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills, SkillValidationError } from './skills'

const FIXTURES = join(import.meta.dirname, '__fixtures__')

test('scans a valid skill with nested files', () => {
  const skills = scanSkills(join(FIXTURES, 'valid'))
  assert.equal(skills.length, 1)
  const s = skills[0]!
  assert.equal(s.name, 'good-skill')
  assert.match(s.description, /valid fixture skill/)
  assert.deepEqual(
    s.files.map((f) => f.path),
    ['SKILL.md', 'references/notes.md'],
  )
})

test('excludes dotfiles and dot-directories', () => {
  const skills = scanSkills(join(FIXTURES, 'valid'))
  const paths = skills[0]!.files.map((f) => f.path)
  assert.ok(!paths.some((p) => p.includes('.hidden')))
  assert.ok(!paths.some((p) => p.includes('.dotfile')))
})

test('sizeBytes is the sum of file sizes', () => {
  const s = scanSkills(join(FIXTURES, 'valid'))[0]!
  const sum = s.files.reduce((acc, f) => acc + f.sizeBytes, 0)
  assert.equal(s.sizeBytes, sum)
  assert.ok(s.sizeBytes > 0)
})

test('file paths use POSIX separators', () => {
  const s = scanSkills(join(FIXTURES, 'valid'))[0]!
  assert.ok(s.files.every((f) => !f.path.includes('\\')))
})

test('reports ALL validation problems at once, not just the first', () => {
  let err: unknown
  try {
    scanSkills(join(FIXTURES, 'broken'))
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof SkillValidationError)
  const joined = err.problems.join('\n')
  assert.equal(err.problems.length, 3)
  assert.match(joined, /no-description.*description/s)
  assert.match(joined, /name-mismatch/)
  assert.match(joined, /not-a-skill.*SKILL\.md/s)
})

test('an absent skills directory is an error', () => {
  assert.throws(() => scanSkills(join(FIXTURES, 'does-not-exist')), /not found/)
})

test('an empty skills directory is an error', () => {
  const empty = mkdtempSync(join(tmpdir(), 'skills-empty-'))
  try {
    assert.throws(() => scanSkills(empty), /no skill directories/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
