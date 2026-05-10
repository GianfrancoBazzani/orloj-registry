# Orloj × Network Economy

> *Built at **ETHPrague 2026**.* User-controlled custody, scoped agent identity, and economic agency — without surrendering autonomy to a custodian.

## The pitch

When a user delegates economic action to an AI agent, three things have to be true at once:

1. **The user owns the keys** — not the agent, not the platform, not the model provider.
2. **The agent has its own identity** — distinct from the user's, scoped to what the user actually delegated, and revocable independently.
3. **The economic surface is permissionless** — anything the user can do, the agent can be authorised to do, on any chain, against any verified contract.

In every existing agent stack, at least one of those collapses. Either the platform holds the key (custodian model), or the agent holds the key (footgun model), or the agent's authority is tied to the user's full session (everything-or-nothing model). Orloj is the design where all three hold simultaneously, enforced architecturally rather than by policy.

## What this gives users

| Property                                 | Mechanism                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No custodian**                         | Keys live in a user-selected HSM-backed KMS (1Claw HSM+TEE or SpaceComputer Orbitport orbital HSM+SpaceTEE). The registry never holds, generates, or reads the key — it only requests signatures on a 32-byte digest.                                       |
| **Scoped agent identity**                | Each agent has its own bearer token (with an mcpk_live prefix, constant-time-checked against Postgres) and a per-vault grant carrying scoped permissions, an optional secret-path pattern, and an optional expiration timestamp. The agent is *not* the user. |
| **One-click revocation**                 | Grants are database rows; revocation is a single update. Bearer tokens can be rotated independently. Revoking an agent's economic agency never requires touching the keys themselves.                                                                       |
| **User identity, not platform identity** | Sign-in is SIWE (with ENS name + avatar lookups via viem) or magic-link via Resend. Vaults and agents are owned by the user record directly — there is no platform-managed wallet between the user and their assets.                                       |
| **Envelope-encrypted sidecar secrets**   | Off-chain credentials the agent needs (API keys, signing salts) are encrypted with a per-vault AES-256-GCM TRANSIT key in the same HSM as the wallet. Only ciphertext lives in our DB; the master key never leaves the enclave.                              |
| **Permissionless economic surface**      | Once granted, an agent can call any Sourcify-verified contract on any chain supported by viem — DEXes, lending, staking, payments, governance. The economic surface is the on-chain economy, not a curated allowlist.                                       |

## Why this matters

For the next generation of on-chain economic actors — agents transacting on behalf of users at scale — autonomy and privacy of asset control are not UI features that can be added later. They are properties of the architecture or they are absent. An agent that holds its own private key is a custodian. A registry that holds the agent's key is a custodian. A wallet that auto-approves without scoped, revocable grants is a custodian.

Orloj is the design where nobody between the user and the chain is holding the user's funds: the user picked the HSM, the user defined the grant, the user can revoke at any time, and the assets remain reachable only by signatures the user explicitly authorised. That is what user-controlled economic agency looks like for autonomous agents — and it generalises across every Ethereum environment without per-deployment work.

## Files of interest

- `packages/app/lib/auth.ts` — Better-Auth with magic-link + SIWE; ENS lookups via viem
- `packages/app/lib/vault-ownership.ts` — per-user vault ownership records, provider-tagged
- `packages/app/lib/agent-ownership.ts` — per-user agent ownership records
- `packages/app/lib/mcp-tokens.ts` — bearer token issuance, rotation, and revocation
- `packages/app/lib/vault-providers/` — pluggable KMS providers (1Claw / Orbitport)
- `packages/registry/src/vault-resolve.js` — agent → grant → vault resolution at signing time
