# Orloj Registry

> *Orloj* (Czech for "astronomical clock") — a nod to Prague's iconic timepiece, built for **ETHPrague Hackathon 2026**.

Orloj is a registry that exposes smart-contract interfaces to AI agents as **MCP (Model Context Protocol) servers**. MCPs are generated dynamically from [Sourcify](https://sourcify.dev/)-verified contract metadata, and signing is delegated to a **pluggable KMS layer** — pick **1Claw** (HSM + TEE) or **SpaceComputer Orbitport** (orbital HSM + SpaceTEE) per vault. Agents discover contracts and call them through a single, hot-pluggable HTTP endpoint — without ever touching keys, RPCs, or gas.

## Tracks Applied

- Ethereum Core
- Network Economy
- [Sourcify Bounty](https://ducttapeevents.notion.site/Sourcify-2fe1a305cfe7805c87a7ce855ae2bde6)
- [SpaceComputer Bounty](https://ducttapeevents.notion.site/SpaceComputer-3101a305cfe7801ca388f3bc292f148d)
- Best UX Flow

## The Problem It Solves

AI agents today can read about smart contracts, but can't *safely* use them. To call a contract, an agent has to:

- manage private keys,
- pick an RPC and handle network failures,
- estimate and pay gas,
- understand each contract's ABI and quirks.

Every one of those is a footgun — and a reason teams don't ship agentic on-chain workflows.

Orloj removes the entire surface. Each contract is published as an MCP server, so the agent sees only **typed, verified interfaces** it can call like any other tool. Account management, signing, and gas are abstracted away by the registry layer; the agent never holds a key and never sees a transaction. The result: agents that can act on-chain with the same ergonomics as calling a REST API.

## Why This Matters for Agents

By abstracting key management and gas handling into the MCP boundary:

- **Simplified mental model.** Agents never need context about blockchain infrastructure, private key custody, or transaction mechanics — only contract interfaces. This shrinks cognitive load and reduces reasoning errors.
- **Infrastructure-agnostic.** Key rotation, HSM policies, network selection, and gas strategies are handled outside the agent's control loop. The agent stays focused on *what to do*, not *how to pay for it*.
- **Lower model requirements.** Even less powerful models (that support tool calling) can reliably execute on-chain operations. The agent doesn't need to reason about gas prices, nonce management, or transaction finality — it just calls a tool with clear inputs/outputs.
- **Higher reliability.** By removing accounts and signing from the agent's purview, you eliminate an entire class of bugs: fund loss, key leakage, stuck transactions, failed estimates. The registry layer enforces correctness.
- **Focused reasoning.** Agents can concentrate entirely on business logic — when to call what function and with what parameters — rather than worrying about the infrastructure layer.

## How It Works

Orloj rests on two pillars:

**1. Sourcify-driven MCP generation.** We use the Sourcify verified-contracts dataset as our source of truth for ABIs. The registry fetches a contract's metadata, parses its ABI, and **dynamically builds an MCP server** where every contract function becomes an MCP tool — with typed inputs, descriptions, and structured outputs. No hand-written wrappers; the moment a contract is verified on Sourcify, it's callable by an agent.

**2. Pluggable KMS-backed vaults.** Each vault holds a wallet whose private key never leaves a hardened enclave. At creation time the user picks the KMS provider:

- **1Claw** — HSM + TEE, intent-based signing. The agent issues a 1Claw *intent* and 1Claw signs inside the TEE.
- **SpaceComputer Orbitport** — secp256k1 keys provisioned inside orbital HSMs with **SpaceTEE**, "physically isolated, tamper-proof by any administrator or state actor." The registry constructs the unsigned tx, sends only the digest to Orbitport, assembles `(r,s,v)` into a broadcast-ready transaction, and submits it via RPC. Secrets stored alongside the wallet are protected by a per-vault TRANSIT (AES-256-GCM) key inside the same HSM (envelope encryption — ciphertext lives in our DB, the key never leaves the enclave).

The provider is recorded per vault, so a single deployment can run both side-by-side. The agent surface stays the same regardless of backend: "describe what you want done."

> SpaceComputer's Orbitport KMS is documented as experimental ("not for production"). Use Sepolia / testnets for the SpaceComputer-backed flows during the demo.

![Orloj architecture: agents call MCP tools generated from Sourcify-verified ABIs; signing is delegated to pluggable KMS vaults (1Claw HSM/TEE or SpaceComputer Orbitport).](architecture.png)

## Challenges We Ran Into

*(Placeholder — to be filled in towards the end of the project.)*

## Technologies Used

**Registry server** ([packages/registry/](packages/registry/))

- Node.js 24 + pnpm workspaces
- Express 5
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (Streamable HTTP transport)
- chokidar — hot-reload of MCP modules
- Zod — schema validation

**Frontend** ([packages/app/](packages/app/))

- Next.js 16
- React 19
- Tailwind CSS v4
- TypeScript

**On-chain & infra**

- [Sourcify](https://sourcify.dev/) — verified contract metadata / ABIs (source of truth for MCP generation)
- 1Claw — key vaults, intent-based signing, HSM-backed keys, TEE signing
- [SpaceComputer Orbitport](https://docs.spacecomputer.io/) — orbital HSM-backed KMS (`@spacecomputer-io/orbitport-sdk-ts`) for secp256k1 signing keys + AES-256-GCM envelope-encryption keys
- viem — local tx construction, digest hashing, signature recovery, broadcasting

**Tooling**

- Claude Code — development
- Claude Design — UI/design exploration

## Run It Locally

```bash
# from repo root
pnpm install

# registry server (http://localhost:3001)
pnpm --filter registry dev

# frontend (http://localhost:3000)
pnpm --filter app dev
```

Node 24.15.0 and pnpm 10.33.2 are pinned via `.npmrc` and `packageManager` — `pnpm install` will refuse on the wrong versions.
