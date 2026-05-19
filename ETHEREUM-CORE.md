# Orloj × Ethereum Core

> *Built at **ETHPrague 2026**.* Wallet defenses for the agentic era of Ethereum — a registry that lets AI agents safely act on-chain without ever holding a key.

## The pitch

The next significant wave of Ethereum actors isn't human. AI agents — autonomous, powerful, and not always correct — are becoming on-chain actors at a pace the existing wallet UX was never designed for. Hardware wallets, transaction simulation, signature warnings, allowance prompts: none of those protect an agent that's been told to *"swap and earn yield"* and is one prompt-injected token approval away from total loss.

Orloj is a wallet and authorization pattern designed for that wave. **Agents never hold a key, never see an RPC, never build a transaction, and can only call verified, typed interfaces under explicit per-grant authorization.** Every assumption above is enforced by the architecture rather than by agent good behavior — which is the only safety argument that survives a stochastic actor.

## What this gives Ethereum

Orloj contributes five practical security properties that don't exist in today's agent stacks:

| Property                                       | Mechanism                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents cannot leak keys**                    | Private material lives in HSM-backed KMS (1Claw HSM+TEE or SpaceComputer Orbitport orbital HSM+SpaceTEE). The registry never holds, generates, or reads the key — it only requests signatures on a 32-byte digest. A compromised registry host or a hallucinating agent cannot exfiltrate.                                  |
| **Agents cannot call unverified contracts**    | Every callable surface is generated from a [Sourcify](https://sourcify.dev/)-verified ABI. Bytecode-mismatched, malicious-look-alike, or unverified contracts have no MCP — they do not exist as far as the agent is concerned.                                                                                            |
| **Agents cannot forge transactions**           | Every state-changing call goes through a per-agent grant lookup against a typed, ABI-derived interface. There is no "raw transaction" path the agent can poison: the registry constructs the EIP-1559 tx with viem, hashes it, sends only the digest to the KMS, and broadcasts the result.                                |
| **Revocation is instant and key-free**         | Per-agent grants carry an expiration timestamp, scoped permissions, and a secret-path pattern; revocation is a single database row update. Bearer tokens (with an mcpk_live prefix) are constant-time-checked against Postgres and can be rotated independently. Revocation never requires touching the keys themselves.   |
| **One pattern, every Ethereum environment**    | The same MCP surface, custody model, and grant logic apply on every chain supported by viem — Mainnet, Sepolia, Arbitrum, Optimism, Base, Gnosis, Polygon. No per-rollup integration; an agent fluent in Orloj is fluent in every Ethereum environment without re-tooling.                                                  |

## Why this matters

Ethereum's safety story has historically been written for human users behind a wallet UI. None of that armor extends to autonomous agents — and the failure mode of a compromised, hallucinating, or misled agent is silent and immediate, with no humans-in-the-loop to catch the obvious-in-hindsight signs.

The agentic era needs an additional layer where the ergonomics are good enough that even less-capable models can act safely, the security guarantees survive worst-case agent behavior, and onboarding a new contract or chain requires zero per-deployment integration. The five properties above describe what that layer needs to be. Orloj is one credible answer.

## Files of interest

- `packages/registry/src/server.rs` — registry HTTP layer, per-MCP routing, bearer-auth gate (the "instant revocation" guarantee)
- `packages/registry/src/sourcify.rs` — Sourcify v2 fetch + ABI parsing (the "no unverified call" guarantee)
- `packages/registry/src/vault/sign_transaction.rs` — provider-agnostic signing path (the "no key leak" guarantee)
- `packages/registry/src/db.rs` — per-agent grant resolution (the "no forgery" guarantee)
- `packages/app/lib/mcp-tokens.ts` — bearer token issuance + revocation
