import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidSkillName,
  validateSkillFiles,
  planInstall,
  SkillPlanError,
  MAX_SKILLS,
} from './install-plan'
import type { IndexedSkill } from './types'

const skill = (name: string, paths: string[] = ['SKILL.md']): IndexedSkill => ({
  name,
  description: 'd',
  contentHash: '0xaa',
  sizeBytes: 10 * paths.length,
  publishedAt: 'now',
  files: paths.map((p) => ({ path: p, rootHash: '0xbb', sizeBytes: 10 })),
})

test('accepts canonical skill names', () => {
  for (const n of ['fire-calculator', 'risk-mindset', 'a', 'a1-b2']) {
    assert.equal(isValidSkillName(n), true, n)
  }
})

test('rejects traversal and shouting in skill names', () => {
  for (const n of ['..', '.', 'a/b', 'A', '-a', 'a-', 'a--b', '', 'a b', 'a.b']) {
    assert.equal(isValidSkillName(n), false, JSON.stringify(n))
  }
})

test('rejects file paths that escape the skill directory', () => {
  for (const p of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a//b', './a', 'a/b/c/d/e']) {
    assert.ok(validateSkillFiles(skill('s', ['SKILL.md', p])).length > 0, p)
  }
})

test('requires a SKILL.md at the skill root', () => {
  assert.ok(validateSkillFiles(skill('s', ['references/x.md'])).length > 0)
  assert.equal(validateSkillFiles(skill('s', ['SKILL.md', 'references/x.md'])).length, 0)
})

test('enforces per-skill file count and byte caps', () => {
  const many = skill('s', ['SKILL.md', ...Array.from({ length: 40 }, (_, i) => `f${i}.md`)])
  assert.ok(validateSkillFiles(many).some((p) => p.includes('files')))

  const big = skill('s')
  big.files[0]!.sizeBytes = 2 * 1024 * 1024
  assert.ok(validateSkillFiles(big).some((p) => p.includes('bytes')))
})

test('rejects a skill with no files at all', () => {
  assert.ok(validateSkillFiles(skill('s', [])).length > 0)
})

test('plans installs, removals and keeps', () => {
  const index = [skill('a'), skill('b'), skill('c')]
  const r = planInstall({ requested: ['a', 'c'], installed: ['a', 'z'], index })
  assert.deepEqual(
    r.install.map((s) => s.name),
    ['c'],
  )
  assert.deepEqual(r.remove, ['z'])
  assert.deepEqual(r.keep, ['a'])
  assert.deepEqual(r.dropped, [])
})

test('unknown requested names are dropped, not fatal', () => {
  const r = planInstall({ requested: ['a', 'ghost'], installed: [], index: [skill('a')] })
  assert.deepEqual(r.dropped, ['ghost'])
  assert.deepEqual(
    r.install.map((s) => s.name),
    ['a'],
  )
})

test('a dropped name that is installed is still removed', () => {
  const r = planInstall({ requested: ['ghost'], installed: ['ghost'], index: [skill('a')] })
  assert.deepEqual(r.dropped, ['ghost'])
  assert.deepEqual(r.remove, ['ghost'])
  assert.deepEqual(r.keep, [])
})

test('clearing the selection removes everything', () => {
  const r = planInstall({ requested: [], installed: ['a', 'b'], index: [skill('a')] })
  assert.deepEqual(r.remove, ['a', 'b'])
  assert.deepEqual(r.install, [])
})

test('an empty request against an empty workspace is a no-op', () => {
  const r = planInstall({ requested: [], installed: [], index: [] })
  assert.deepEqual(r, { install: [], remove: [], keep: [], dropped: [] })
})

test('duplicate requested names collapse', () => {
  const r = planInstall({ requested: ['a', 'a'], installed: [], index: [skill('a')] })
  assert.equal(r.install.length, 1)
})

test('rejects an oversized selection', () => {
  const requested = Array.from({ length: MAX_SKILLS + 1 }, (_, i) => `s${i}`)
  assert.throws(() => planInstall({ requested, installed: [], index: [] }), SkillPlanError)
})

test('rejects an invalid requested name before touching the index', () => {
  assert.throws(
    () => planInstall({ requested: ['../etc'], installed: [], index: [] }),
    SkillPlanError,
  )
})

test('rejects a resolved skill whose files fail validation', () => {
  assert.throws(
    () =>
      planInstall({
        requested: ['a'],
        installed: [],
        index: [skill('a', ['SKILL.md', '../escape.md'])],
      }),
    SkillPlanError,
  )
})

test('a hostile skill already on disk is removable without validating its files', () => {
  // Removal must never be blocked by the index: the directory is already there.
  const r = planInstall({
    requested: [],
    installed: ['a'],
    index: [skill('a', ['SKILL.md', '../escape.md'])],
  })
  assert.deepEqual(r.remove, ['a'])
})
