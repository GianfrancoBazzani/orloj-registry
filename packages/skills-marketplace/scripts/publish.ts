import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { scanSkills, SkillValidationError } from '../src/skills'
import { checkSafety } from '../src/safety'
import { contentHashOf, merkleRootOf } from '../src/hash'
import { diffSkills, type HashedSkill } from '../src/diff'
import {
  buildIndex,
  buildPointer,
  networkMismatch,
  readCommittedIndex,
  serializeIndex,
  serializePointer,
} from '../src/index-file'
import { formatManifest, formatOg } from '../src/manifest'
import { needsTypedConfirmation, promptForWord } from '../src/gate'
import { createZgClient } from '../src/zg'

const packageDir = join(import.meta.dirname, '..')

function fail(message: string): never {
  console.error(`\nerror: ${message}`)
  process.exit(1)
}

const config = (() => {
  try {
    return loadConfig(process.argv.slice(2), process.env, packageDir)
  } catch (e) {
    fail((e as Error).message)
  }
})()

// --- scan and validate -----------------------------------------------------
const scanned = (() => {
  try {
    return scanSkills(config.skillsDir)
  } catch (e) {
    if (e instanceof SkillValidationError) {
      fail(`${e.problems.length} problem(s):\n  - ${e.problems.join('\n  - ')}`)
    }
    fail((e as Error).message)
  }
})()

const selected = config.flags.only
  ? scanned.filter((s) => s.name === config.flags.only)
  : scanned

if (config.flags.only && selected.length === 0) {
  fail(
    `--only "${config.flags.only}" matched no skill. Available: ` +
      scanned.map((s) => s.name).join(', '),
  )
}

// --- safety ----------------------------------------------------------------
const safety = checkSafety(selected)
if (safety.refusals.length > 0) {
  fail(`safety check refused these files:\n  - ${safety.refusals.join('\n  - ')}`)
}

// --- hash ------------------------------------------------------------------
const hashed: HashedSkill[] = []
for (const skill of selected) {
  const files = []
  for (const file of skill.files) {
    files.push({ ...file, rootHash: await merkleRootOf(file.bytes) })
  }
  hashed.push({
    name: skill.name,
    description: skill.description,
    contentHash: contentHashOf(files),
    sizeBytes: skill.sizeBytes,
    files,
  })
}

// --- diff ------------------------------------------------------------------
const committed = readCommittedIndex(config.indexPath)

const mismatch = networkMismatch(committed, config.network)
if (mismatch && !config.flags.allowNetworkSwitch) fail(mismatch)

const diff = diffSkills(hashed, committed, {
  force: config.flags.force,
  networkSwitch: Boolean(mismatch) && config.flags.allowNetworkSwitch,
})

// --- build the prospective index -------------------------------------------
const now = new Date().toISOString()
const prospective = buildIndex(
  hashed,
  { chainId: config.network.chainId, name: config.network.name },
  committed,
  now,
)
const prospectiveJson = serializeIndex(prospective)
const committedJson = committed ? serializeIndex(committed) : null
const indexChanged = prospectiveJson !== committedJson

// --- manifest --------------------------------------------------------------
const client = await createZgClient(config.network, config.privateKey)
const balance = await client.balance()

const blobsToPrice = [
  ...diff.toUpload.map((f) => f.bytes),
  ...(indexChanged ? [new TextEncoder().encode(prospectiveJson)] : []),
]
const estimatedFee = await client.estimateFee(blobsToPrice)

console.log(
  formatManifest({
    network: config.network,
    signer: client.address,
    balanceWei: balance,
    estimatedFeeWei: estimatedFee,
    files: diff.files,
    safety,
    willUploadIndex: indexChanged,
    confirmed: config.flags.confirm,
  }),
)

if (diff.toUpload.length === 0 && !indexChanged) process.exit(0)
if (!config.flags.confirm) process.exit(0)

// --- gate ------------------------------------------------------------------
if (balance < estimatedFee) {
  fail(
    `balance ${formatOg(balance)} is below the estimated fee ` +
      `${formatOg(estimatedFee)}` +
      (config.network.faucet ? `. Faucet: ${config.network.faucet}` : ''),
  )
}

if (needsTypedConfirmation(config.network, config.flags.confirm)) {
  if (!process.stdin.isTTY) {
    fail(
      'publishing to mainnet requires an interactive terminal. ' +
        'Refusing to spend real funds unattended.',
    )
  }
  console.log('')
  const ok = await promptForWord(
    config.network.confirmationWord!,
    process.stdin,
    process.stdout,
  )
  if (!ok) fail('confirmation did not match. Nothing was uploaded.')
}

// --- upload ----------------------------------------------------------------
console.log('')
for (const [i, file] of diff.toUpload.entries()) {
  const label = `${file.skill}/${file.path}`
  process.stdout.write(`  [${i + 1}/${diff.toUpload.length}] ${label} … `)
  const result = await client.uploadBlob(file.bytes)
  if (result.rootHash !== file.rootHash) {
    fail(
      `root mismatch for ${label}: computed ${file.rootHash}, ` +
        `network returned ${result.rootHash}. Nothing written.`,
    )
  }
  console.log(`${result.rootHash} (tx ${result.txHash})`)
}

if (!indexChanged) {
  console.log('\nindex unchanged — not re-uploading. Nothing written.')
  process.exit(0)
}

const indexBytes = new TextEncoder().encode(prospectiveJson)
process.stdout.write('  index … ')
const indexUpload = await client.uploadBlob(indexBytes)
console.log(`${indexUpload.rootHash} (tx ${indexUpload.txHash})`)

// --- write -----------------------------------------------------------------
const pointer = buildPointer({
  indexRoot: indexUpload.rootHash,
  indexTxHash: indexUpload.txHash,
  indexSizeBytes: indexBytes.length,
  skillCount: prospective.skills.length,
  publisher: client.address,
  network: {
    chainId: config.network.chainId,
    name: config.network.name,
    indexerRpc: config.network.indexerRpc,
  },
  publishedAt: now,
})

writeFileSync(config.indexPath, prospectiveJson)
writeFileSync(config.pointerPath, serializePointer(pointer))

console.log('')
console.log('wrote skills-index.json and marketplace.json')
console.log(`index root  ${indexUpload.rootHash}`)
console.log(`explorer    ${config.network.storageExplorer}`)
console.log('')
console.log('Review the diff, then commit both files.')
