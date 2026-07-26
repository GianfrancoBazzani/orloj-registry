import type { LocalSkill } from './skills'

export interface SafetyReport {
  refusals: string[]
  warnings: string[]
}

const DENIED_FILENAMES: RegExp[] = [
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)\.env/i,
]

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const BARE_64_HEX = /0x[0-9a-fA-F]{64}\b/

export function checkSafety(skills: LocalSkill[]): SafetyReport {
  const refusals: string[] = []
  const warnings: string[] = []
  const decoder = new TextDecoder('utf8', { fatal: false })

  for (const skill of skills) {
    for (const file of skill.files) {
      const where = `${skill.name}/${file.path}`

      if (DENIED_FILENAMES.some((re) => re.test(file.path))) {
        refusals.push(`${where}: filename matches the secret denylist`)
        continue
      }

      const text = decoder.decode(file.bytes)

      if (PEM_PRIVATE_KEY.test(text)) {
        refusals.push(`${where}: contains a PEM PRIVATE KEY block`)
        continue
      }

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (BARE_64_HEX.test(lines[i]!)) {
          warnings.push(
            `${where}: line ${i + 1} contains a 64-hex value — ` +
              `expected for hashes, but verify it is not a private key`,
          )
          break
        }
      }
    }
  }

  return { refusals, warnings }
}
