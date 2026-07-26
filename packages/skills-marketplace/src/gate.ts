import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { NetworkProfile } from './networks'

export function needsTypedConfirmation(
  profile: NetworkProfile,
  confirm: boolean,
): boolean {
  return confirm && profile.requiresTypedConfirmation
}

export async function promptForWord(
  word: string,
  input: Readable,
  output: Writable,
): Promise<boolean> {
  const rl = createInterface({ input, output, terminal: false })
  try {
    output.write(`Type "${word}" to confirm publishing to mainnet: `)
    const iterator = rl[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    return String(value ?? '').trim().toLowerCase() === word.toLowerCase()
  } finally {
    rl.close()
  }
}
