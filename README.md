# Orloj Registry

> *Orloj* (Czech for "astronomical clock") — a nod to Prague's iconic timepiece, built for **ETHPrague Hackathon 2026**.

Orloj is a registry that exposes smart-contract interfaces to AI agents as **MCP (Model Context Protocol) servers**. MCPs are generated dynamically from [Sourcify](https://sourcify.dev/)-verified contract metadata, and signing is delegated to **1Claw** vaults backed by HSM + TEE. Agents discover contracts and call them through a single, hot-pluggable HTTP endpoint — without ever touching keys, RPCs, or gas.

## Tracks Applied

- Ethereum Core
- Network Economy
- [Sourcify Bounty](https://ducttapeevents.notion.site/Sourcify-2fe1a305cfe7805c87a7ce855ae2bde6)
- Best UX Flow

## The Problem It Solves

AI agents today can read about smart contracts, but can't *safely* use them. To call a contract, an agent has to:

- manage private keys,
- pick an RPC and handle network failures,
- estimate and pay gas,
- understand each contract's ABI and quirks.

Every one of those is a footgun — and a reason teams don't ship agentic on-chain workflows.

Orloj removes the entire surface. Each contract is published as an MCP server, so the agent sees only **typed, verified interfaces** it can call like any other tool. Account management, signing, and gas are abstracted away by the registry layer; the agent never holds a key and never sees a transaction. The result: agents that can act on-chain with the same ergonomics as calling a REST API.

## How It Works

Orloj rests on two pillars:

**1. Sourcify-driven MCP generation.** We use the Sourcify verified-contracts dataset as our source of truth for ABIs. The registry fetches a contract's metadata, parses its ABI, and **dynamically builds an MCP server** where every contract function becomes an MCP tool — with typed inputs, descriptions, and structured outputs. No hand-written wrappers; the moment a contract is verified on Sourcify, it's callable by an agent.

**2. 1Claw vaults for keys.** Users create a vault in 1Claw to hold their private keys. The agent **never sees the key**: it issues a 1Claw *intent* describing the call it wants to make, and 1Claw signs the transaction inside a **TEE** with keys that live in an **HSM**. The agent's surface area shrinks to "describe what you want done" — signing, custody, and policy enforcement happen in hardened infrastructure.

![Orloj architecture: agents call MCP tools generated from Sourcify-verified ABIs; signing is delegated to 1Claw vaults (HSM + TEE).](architecture.png)

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
