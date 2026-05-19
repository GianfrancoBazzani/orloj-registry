# Orloj × SpaceComputer

> *Built at **ETHPrague 2026**.* An end-to-end signing and authorization service for AI agents, built on the Orbitport KMS.

## The pitch

Orloj turns Sourcify-verified smart contracts into MCP servers that AI agents call as typed tools. The agents never see private keys, RPCs, or unsigned transactions — and the reason that is *credible* is that every wallet Orloj manages is an Orbitport KMS key. **Orloj is, end to end, a secure signing and authorization service for autonomous AI agents** — a category that didn't exist a year ago, implemented on top of orbital HSM + SpaceTEE.

What's unusual about it: Orbitport isn't an optional plug-in. The wallet's private material is *only ever* an Orbitport KMS key id; there is no path through the system where the registry process holds, generates, or sees the private key. A compromised registry host cannot forge transactions — it can only request signatures it is already authorized to request, on a digest, against a key that lives in orbit.

## How we use Orbitport KMS (depth, across both schemes)

Most KMS integrations stop at "create a key, ask it to sign once." Orloj uses **both** Orbitport key schemes, **four distinct KMS operations**, in **two services** across the codebase:

| Where                                          | KMS operation   | Scheme / key                     | Why                                                                                                  |
| ---------------------------------------------- | --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| App / createVault                              | kms.createKey   | ETHEREUM / ECC_SECG_P256K1       | Per-vault wallet signing key — Orbitport returns the derived Ethereum address                        |
| App / createVault                              | kms.createKey   | TRANSIT / AES_256_GCM96          | Per-vault envelope-encryption key, in the same security domain as the wallet                         |
| App / setSecret                                | kms.encrypt    | TRANSIT                          | Encrypts secret-store plaintext — only the ciphertext blob is persisted to Postgres                  |
| App / getSecret                                | kms.decrypt    | TRANSIT                          | Decrypts on read — cleartext never lives on disk on our side                                         |
| Registry / on every agent write-tool call      | kms.sign       | ETHEREUM, messageType DIGEST     | Signs the keccak256 of an EIP-1559 unsigned tx; the (r, s, v) signature is reassembled and broadcast |
| App / signDigest                               | kms.sign       | ETHEREUM, messageType DIGEST     | Same primitive exposed through the vault-provider abstraction for control-plane use                  |

**The signing path is the live transaction broadcast path, not a demo button.** When an AI agent calls a write function on any Sourcify-generated MCP, Orloj builds the EIP-1559 tx with viem, hashes it, sends *only the digest* to Orbitport, gets back `(r, s, v)`, reassembles with `serializeTransaction`, and broadcasts. Every state-changing on-chain call an agent makes through Orloj transits Orbitport.

**Envelope encryption is not a side feature.** Per-vault TRANSIT keys mean that any secrets stored alongside the wallet (off-chain credentials, API keys, signing salts) live under the same physical custody as the wallet itself. Ciphertext lives in our DB; the master key lives in orbit. Combining the ETHEREUM and TRANSIT schemes inside a single product surface keeps the wallet and its sidecar secrets in one security domain — a property that falls out naturally from the design rather than being bolted on.

**Per-agent grants tie it all together.** Each agent has a recorded grant against a vault (with `permissions`, `secret_path_pattern`, optional `expires_at`); the registry resolves that grant on every MCP call and signs through the matching Orbitport key. Revocation is instant and never touches the keys themselves.

## Why this matters

Orloj's pitch — *let agents act on-chain with the ergonomics of a REST call* — depends on a credible answer to *whose keys are being used and where do they live*. Orbitport is the answer that takes the question off the table the hardest: keys live in orbit, in tamper-proof hardware, signing only what an authenticated, grant-bearing agent asks for.

Beyond this demo, Orbitport is what makes the category — HSM-grade custody for autonomous AI agents calling smart contracts — possible at all. AI agents acting on-chain through MCP is itself a new pattern; pairing it with signatures that cannot be forged by an operator, a state actor, or a compromised host is what turns it into something credible to ship. Every Sourcify-verified contract across 100+ chains becomes callable by an LLM through an MCP server, with the wallet's private material never leaving orbit.

## Files of interest

- `packages/app/lib/vault-providers/orbitport.ts` — full KMS provider: `createKey` (both schemes), `encrypt`/`decrypt` (TRANSIT), `sign` (ETHEREUM), key-grant CRUD
- `packages/registry/src/vault/sign_transaction.rs` — provider router on the live transaction path; Orbitport path sends digest → gets `(r,s,v)` → broadcasts
- `packages/registry/src/db.rs` — `resolve_vault()`: agent → grant → vault → KMS-key-id resolution
- `packages/app/lib/db.ts` — `orbitport_vault` / `orbitport_secret` / `orbitport_grant` schema
