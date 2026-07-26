import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSafety } from './safety'
import type { LocalSkill } from './skills'

const enc = (s: string) => new TextEncoder().encode(s)

function skill(files: { path: string; content: string }[]): LocalSkill {
  const mapped = files.map((f) => ({
    path: f.path,
    bytes: enc(f.content),
    sizeBytes: enc(f.content).length,
  }))
  return {
    name: 'fixture',
    description: 'fixture',
    dir: '/tmp/fixture',
    files: mapped,
    sizeBytes: mapped.reduce((a, f) => a + f.sizeBytes, 0),
  }
}

test('clean skill produces no refusals and no warnings', () => {
  const r = checkSafety([skill([{ path: 'SKILL.md', content: '# hello' }])])
  assert.deepEqual(r.refusals, [])
  assert.deepEqual(r.warnings, [])
})

test('refuses denylisted filenames', () => {
  for (const path of [
    'server.pem',
    'deploy.key',
    'id_rsa',
    'certs/bundle.p12',
    '.env.local',
  ]) {
    const r = checkSafety([skill([{ path, content: 'x' }])])
    assert.equal(r.refusals.length, 1, `expected refusal for ${path}`)
    assert.match(r.refusals[0]!, new RegExp(path.replace(/[.]/g, '\\.')))
  }
})

test('refuses PEM private key blocks by content', () => {
  const r = checkSafety([
    skill([
      { path: 'SKILL.md', content: '-----BEGIN RSA PRIVATE KEY-----\nabc\n' },
    ]),
  ])
  assert.equal(r.refusals.length, 1)
  assert.match(r.refusals[0]!, /PRIVATE KEY/)
})

test('warns but does not refuse on a bare 64-hex string', () => {
  const hex = '0x' + 'a'.repeat(64)
  const r = checkSafety([skill([{ path: 'SKILL.md', content: `hash: ${hex}` }])])
  assert.deepEqual(r.refusals, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /SKILL\.md/)
})

test('warning names the line number', () => {
  const hex = '0x' + 'b'.repeat(64)
  const r = checkSafety([skill([{ path: 'SKILL.md', content: `a\nb\n${hex}` }])])
  assert.match(r.warnings[0]!, /line 3/)
})

test('collects problems across multiple skills', () => {
  const r = checkSafety([
    skill([{ path: 'a.key', content: 'x' }]),
    skill([{ path: 'SKILL.md', content: '0x' + 'c'.repeat(64) }]),
  ])
  assert.equal(r.refusals.length, 1)
  assert.equal(r.warnings.length, 1)
})
