# Orloj Registry

> *Orloj* (Czech for "astronomical clock") — a nod to Prague's iconic timepiece, built for **ETHPrague Hackathon 2026**.

Orloj is a registry that exposes smart-contract interfaces to AI agents as **MCP (Model Context Protocol) servers**. MCPs are generated dynamically from [Sourcify](https://sourcify.dev/)-verified contract metadata, and signing is delegated to a **pluggable KMS layer** — pick **1Claw** (HSM + TEE) or **SpaceComputer Orbitport** (orbital HSM + SpaceTEE) per vault. Each registered contract is served as its own MCP endpoint by a single hot-pluggable registry process, gated by per-agent bearer tokens — agents never touch keys, RPCs, or gas.

## Highlights

- **Sourcify ABI → typed MCP server, dynamically generated.** Every function in a verified contract becomes an MCP tool with Solidity types parsed by alloy's `JsonAbi` and encoded/decoded at runtime via `DynSolValue` (tuples, dynamic + fixed-size arrays, all integer widths, `bytesN`), proxy ABIs resolved automatically via Sourcify's `proxyResolution` field. Zero per-contract integration: the moment a contract is verified on Sourcify, it is callable by an agent.
- **Hardware-rooted, pluggable KMS — keys never leave the enclave.** Each vault picks its signing backend: SpaceComputer Orbitport (orbital HSM + SpaceTEE; signing happens entirely inside the enclave on a 32-byte digest, with both `ETHEREUM` and `TRANSIT` schemes used in the same product surface for wallet signing *and* envelope-encrypted secret storage) or 1Claw (HSM + TEE intent signing). Both backends are wired into the same `signTransaction` path, so the agent surface is identical regardless of where the key lives.
- **Agents never hold a key, never see a transaction.** The registry constructs every EIP-1559 tx with viem, hashes it, asks the chosen KMS to sign the digest, reassembles `(r, s, yParity)`, and broadcasts. A compromised registry host cannot forge transactions — it can only request signatures it is already authorized to request, on a digest, against a key it does not hold.
- **Per-agent bearer tokens with grant-based authorization.** Each agent has a `mcpk_live_*` token (constant-time-checked against Postgres) and a per-vault grant carrying `permissions`, optional `secret_path_pattern`, and optional `expires_at`. The registry resolves the active grant on every MCP call and routes the signature to the matching KMS key. Revocation is a row update; keys never move.

## Tracks Applied

- Ethereum Core — see [`ETHEREUM-CORE.md`](ETHEREUM-CORE.md) for our integration writeup
- Network Economy — see [`NETWORK-ECONOMY.md`](NETWORK-ECONOMY.md) for our integration writeup
- [Sourcify Bounty](https://ducttapeevents.notion.site/Sourcify-2fe1a305cfe7805c87a7ce855ae2bde6) — see [`SOURCIFY.md`](SOURCIFY.md) for our integration writeup
- [SpaceComputer Bounty](https://ducttapeevents.notion.site/SpaceComputer-3101a305cfe7801ca388f3bc292f148d) — see [`SPACECOMPUTER.md`](SPACECOMPUTER.md) for our integration writeup
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

- Rust (Cargo — not a pnpm workspace member)
- axum 0.7 — HTTP server
- [rmcp 0.16](https://github.com/modelcontextprotocol/rust-sdk) — MCP protocol, Streamable HTTP transport
- alloy 2.0 — ABI parsing (`JsonAbi`), calldata encoding/decoding (`DynSolValue`), EIP-1559 tx construction
- sqlx 0.8 — async Postgres; per-agent bearer tokens (`mcpk_live_*`) verified with constant-time comparison

**Frontend / control plane** ([packages/app/](packages/app/))

- Next.js 16, React 19, Tailwind CSS v4, TypeScript
- Better-Auth with magic-link (Resend) + SIWE, ENS lookups via viem
- Postgres (vault ownership, agent ownership, MCP API keys, Orbitport vault metadata + envelope-encrypted secrets)

**On-chain & infra**

- [Sourcify](https://sourcify.dev/) — verified contract metadata / ABIs (source of truth for MCP generation)
- [1Claw](https://1claw.xyz/) — key vaults, intent-based signing, HSM-backed keys, TEE signing
- [SpaceComputer Orbitport](https://docs.spacecomputer.io/) — orbital HSM-backed KMS (`@spacecomputer-io/orbitport-sdk-ts`) for secp256k1 signing keys + AES-256-GCM envelope-encryption keys
- viem — local tx construction, digest hashing, signature recovery, broadcasting

**Tooling**

- Claude Code — development
- Claude Design — UI/design exploration

## Run It Locally

```bash
./dev.sh
```

Starts Postgres (Docker), the registry on `:3001`, and the app on `:3000`, creating
`.env` files from the examples on first run. Idempotent — anything already running is
reused, so it is safe to re-run. Pass `--no-docker` to use a Postgres you started
yourself. Fill in the generated `.env` files with your own secrets before the
KMS-backed flows will work.

The rest of this section is the manual equivalent.

The registry reads `.env`; the app reads `.env.local`. Copy the examples and fill in secrets before starting:

```bash
# from repo root
cp packages/registry/.env.example packages/registry/.env
cp packages/app/.env.example      packages/app/.env.local
```

### Database

Both services create their own tables on first connection, so any empty Postgres works.
The quickest way to get one:

```bash
docker compose up -d          # postgres on 127.0.0.1:5432, db `orloj`
```

Then set this in **both** `.env` files:

```
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/orloj?sslmode=disable"
```

`docker compose down` stops it and keeps your data; `docker compose down -v` wipes it for
a clean slate. An existing local or hosted Postgres works just as well — point
`DATABASE_URL` at it and skip the container.

Fill in at least:

- **`packages/registry/.env`** — `DATABASE_URL` (same Postgres as the app), and either `ONECLAW_API_KEY` + `ONECLAW_BASE_URL` or `ORBITPORT_CLIENT_ID` + `ORBITPORT_CLIENT_SECRET` depending on which vault provider you'll sign with.
- **`packages/app/.env.local`** — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (defaults to `http://localhost:3000`), `RESEND_API_KEY` + `EMAIL_FROM` for magic-link sign-in, `REGISTRY_URL=http://localhost:3001` so the app can proxy to the registry, plus the same KMS credentials. Optional: `ETH_RPC_URL`, `ETH_RPC_URL_SEPOLIA`, `ENS_CHAIN`.

### Optional: the onchain market sentiment MCP

The `feeling` MCP (dashboard at `/sentiment`) reads Uniswap V3 swap flow through a
Substreams module that is **not** committed as a build artifact, so it needs one setup
pass. Skip this and the rest of the registry still runs — only `/sentiment` is affected.

```bash
cd packages/substreams-sentiment
SUBSTREAMS_API_KEY=server_... ./setup.sh
```

The script checks your toolchain, builds the WASM module, validates the manifest, and
exchanges your API key for the JWT the endpoint requires (the raw key is rejected). It
is idempotent — re-run it any time. Get a free key at
[thegraph.com/studio](https://thegraph.com/studio) or
[app.streamingfast.io](https://app.streamingfast.io); it prints the
`SUBSTREAMS_API_TOKEN` line to paste into `packages/registry/.env`.

Then run:

```bash
# registry server (http://localhost:3001) — from packages/registry/
cargo run

# frontend (http://localhost:3000) — from repo root or packages/app/
pnpm install   # app only; registry is Rust/Cargo
pnpm --filter app dev
```

Node 24.15.0 and pnpm 10.33.2 are pinned via `.npmrc` and `packageManager` — `pnpm install` will refuse on the wrong versions (applies to the app only).
