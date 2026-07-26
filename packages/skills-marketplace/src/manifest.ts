import { formatUnits } from 'ethers'
import type { FilePlan } from './diff'
import type { NetworkProfile } from './networks'
import type { SafetyReport } from './safety'

export function formatOg(wei: bigint): string {
  const whole = formatUnits(wei, 18)
  const [int, frac = ''] = whole.split('.')
  return `${int}.${frac.padEnd(9, '0').slice(0, 9)} 0G`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export interface ManifestArgs {
  network: NetworkProfile
  signer: string
  balanceWei: bigint
  estimatedFeeWei: bigint
  files: FilePlan[]
  safety: SafetyReport
  willUploadIndex: boolean
  confirmed: boolean
}

export function formatManifest(args: ManifestArgs): string {
  const lines: string[] = []
  const toUpload = args.files.filter((f) => f.status !== 'unchanged')
  const txCount = toUpload.length + (args.willUploadIndex ? 1 : 0)

  lines.push('0G skills marketplace publisher')
  lines.push(`  network   ${args.network.name} (chainId ${args.network.chainId})`)
  lines.push(`  indexer   ${args.network.indexerRpc}`)
  lines.push(`  signer    ${args.signer}`)
  lines.push(`  balance   ${formatOg(args.balanceWei)}`)
  lines.push('')

  const width = Math.max(
    ...args.files.map((f) => `${f.skill}/${f.path}`.length),
    10,
  )
  for (const f of args.files) {
    const label = `${f.skill}/${f.path}`.padEnd(width)
    const size = formatBytes(f.sizeBytes).padStart(8)
    lines.push(`  ${label}  ${size}  ${f.status}`)
  }
  lines.push('')

  if (args.safety.warnings.length > 0) {
    lines.push('warnings:')
    for (const w of args.safety.warnings) lines.push(`  ! ${w}`)
    lines.push('')
  }

  if (txCount === 0) {
    lines.push('Nothing to publish — every file is already on 0G Storage and the')
    lines.push('index is unchanged. No transactions, no file writes.')
    return lines.join('\n')
  }

  lines.push(
    `${toUpload.length} file(s) to upload` +
      (args.willUploadIndex ? ' plus the index' : '') +
      ` = ${txCount} transactions`,
  )
  lines.push(
    `estimated storage fee  ${formatOg(args.estimatedFeeWei)} (excludes gas)`,
  )

  if (!args.confirmed) {
    lines.push('')
    lines.push('DRY RUN — nothing was uploaded and no files were written.')
    lines.push('Re-run with --confirm to publish.')
  }

  return lines.join('\n')
}
