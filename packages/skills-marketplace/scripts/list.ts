import { join } from 'node:path'
import { readCommittedIndex } from '../src/index-file'
import { formatBytes } from '../src/manifest'

const packageDir = join(import.meta.dirname, '..')
const index = readCommittedIndex(join(packageDir, 'skills-index.json'))

if (!index) {
  console.error('no skills-index.json yet — run publish:skills first')
  process.exit(1)
}

console.log(`${index.network.name} (chainId ${index.network.chainId})`)
console.log(`${index.skills.length} skills\n`)

const width = Math.max(...index.skills.map((s) => s.name.length))
for (const skill of index.skills) {
  console.log(
    `  ${skill.name.padEnd(width)}  ${formatBytes(skill.sizeBytes).padStart(8)}` +
      `  ${skill.files.length} file(s)  ${skill.publishedAt}`,
  )
  for (const file of skill.files) {
    console.log(`      ${file.path}  ${file.rootHash}`)
  }
}
