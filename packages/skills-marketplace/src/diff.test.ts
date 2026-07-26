import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSkills, type HashedSkill } from './diff'
import type { SkillsIndex } from './types'

const enc = (s: string) => new TextEncoder().encode(s)

function hashed(name: string, files: [string, string][]): HashedSkill {
  return {
    name,
    description: `${name} description`,
    contentHash: `0xhash-${name}`,
    sizeBytes: files.length,
    files: files.map(([path, rootHash]) => ({
      path,
      rootHash,
      bytes: enc(path + rootHash),
      sizeBytes: 1,
    })),
  }
}

const committed: SkillsIndex = {
  schemaVersion: 1,
  network: { chainId: 16661, name: '0g-aristotle-mainnet' },
  skills: [
    {
      name: 'alpha',
      description: 'alpha description',
      contentHash: '0xhash-alpha',
      sizeBytes: 1,
      publishedAt: '2026-07-01T00:00:00.000Z',
      files: [{ path: 'SKILL.md', rootHash: '0xaaa', sizeBytes: 1 }],
    },
  ],
}

const noOpts = { force: false, networkSwitch: false }

test('everything is new when there is no committed index', () => {
  const r = diffSkills([hashed('alpha', [['SKILL.md', '0xaaa']])], null, noOpts)
  assert.equal(r.files[0]!.status, 'new')
  assert.equal(r.toUpload.length, 1)
})

test('identical root is unchanged and not uploaded', () => {
  const r = diffSkills(
    [hashed('alpha', [['SKILL.md', '0xaaa']])],
    committed,
    noOpts,
  )
  assert.equal(r.files[0]!.status, 'unchanged')
  assert.equal(r.toUpload.length, 0)
})

test('different root for a known path is changed', () => {
  const r = diffSkills(
    [hashed('alpha', [['SKILL.md', '0xbbb']])],
    committed,
    noOpts,
  )
  assert.equal(r.files[0]!.status, 'changed')
  assert.equal(r.toUpload.length, 1)
})

test('an unknown path in a known skill is new', () => {
  const r = diffSkills(
    [
      hashed('alpha', [
        ['SKILL.md', '0xaaa'],
        ['references/n.md', '0xccc'],
      ]),
    ],
    committed,
    noOpts,
  )
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f.status]))
  assert.equal(byPath['SKILL.md'], 'unchanged')
  assert.equal(byPath['references/n.md'], 'new')
  assert.equal(r.toUpload.length, 1)
})

test('an unknown skill is new', () => {
  const r = diffSkills([hashed('beta', [['SKILL.md', '0xzzz']])], committed, noOpts)
  assert.equal(r.files[0]!.status, 'new')
})

test('force reclassifies everything as new', () => {
  const r = diffSkills([hashed('alpha', [['SKILL.md', '0xaaa']])], committed, {
    force: true,
    networkSwitch: false,
  })
  assert.equal(r.files[0]!.status, 'new')
  assert.equal(r.toUpload.length, 1)
})

test('a network switch reclassifies everything as new', () => {
  const r = diffSkills([hashed('alpha', [['SKILL.md', '0xaaa']])], committed, {
    force: false,
    networkSwitch: true,
  })
  assert.equal(r.files[0]!.status, 'new')
})

test('root comparison is case-insensitive', () => {
  const r = diffSkills(
    [hashed('alpha', [['SKILL.md', '0xAAA']])],
    committed,
    noOpts,
  )
  assert.equal(r.files[0]!.status, 'unchanged')
})

test('files carry their skill name for display', () => {
  const r = diffSkills(
    [hashed('alpha', [['SKILL.md', '0xaaa']])],
    committed,
    noOpts,
  )
  assert.equal(r.files[0]!.skill, 'alpha')
})
