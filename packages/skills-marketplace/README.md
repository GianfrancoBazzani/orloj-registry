# @orloj/skills-marketplace

Publishes the skills in `skills/` to 0G Storage and records what was published
in two committed files:

- `skills-index.json` — the catalog: every skill, its description, and the 0G
  Storage root hash of each of its files. Also uploaded to 0G Storage.
- `marketplace.json` — the pointer: the root hash of the index itself, the
  transaction that stored it, and which network it lives on.

Consumers read `marketplace.json` to find the index, then fetch content by root
hash. No contract is deployed; 0G's pre-existing Flow contract does the storing.

## Setup

    cp .env.example .env    # then fill in ZG_PRIVATE_KEY

## Publishing

Dry run is the default. Nothing is uploaded and nothing is written unless you
pass `--confirm`.

    pnpm upload:skills                              # dry run, mainnet
    pnpm upload:skills --confirm                    # prompts: type 'aristotle'

    pnpm upload:skills --network testnet             # dry run, free
    pnpm upload:skills --network testnet --confirm   # rehearse for real

| Flag | Effect |
|---|---|
| `--confirm` | Actually upload. On mainnet also needs the typed word on a TTY |
| `--network <mainnet\|testnet>` | Defaults to `mainnet` |
| `--only <name>` | Upload one skill's files; still rebuilds the whole index |
| `--force` | Re-upload roots already recorded as published |
| `--allow-network-switch` | Permit targeting a different network than the index records |

Republishing with nothing changed is a no-op: zero uploads, zero transactions,
and both JSON files stay byte-identical.

## Provenance

Everything published here was uploaded by one wallet. Both links are verified;
StorageScan has no working per-root-hash URL, so there is nothing to link for an
individual skill file.

- Publisher, with every file it has uploaded —
  <https://storagescan.0g.ai/address/0xDCeb0C6598c28592f55d8CCF0bFDaA0A7B2012D8>
- The index-storage transaction —
  <https://chainscan.0g.ai/tx/0x448f6d8c97251ad593bc43576e2886da9f5e799ffb8ed67a20edeccff7fb5b02>

## Consuming

`packages/app` reads this marketplace at runtime. It imports `marketplace.json`,
fetches the index from 0G by `indexRoot`, and installs individual skills into an
agent's zeroclaw workspace:

```ts
import { fetchIndex, fetchVerified } from '@orloj/skills-marketplace/gateway'
import { planInstall } from '@orloj/skills-marketplace/install-plan'
import pointer from '@orloj/skills-marketplace/marketplace.json'

const index = await fetchIndex({ pointer })
```

Both helpers recompute the 0G Merkle root of whatever the gateway returned and
reject a mismatch, so a compromised indexer cannot inject content. Reads go over
plain HTTP (`GET {indexerRpc}/file?root=0x…`); the SDK is only used for hashing.

## Inspecting

    pnpm list:skills     # print the committed index (offline)
    pnpm verify:skills   # re-download every root and byte-compare
    pnpm smoke           # read-only SDK check; --upload to store a test blob

## Networks

| | Aristotle mainnet | Galileo testnet |
|---|---|---|
| Chain ID | 16661 | 16602 |
| RPC | `https://evmrpc.0g.ai` | `https://evmrpc-testnet.0g.ai` |
| Indexer | `https://indexer-storage-turbo.0g.ai` | `https://indexer-storage-testnet-turbo.0g.ai` |
| Explorer | `https://chainscan.0g.ai` | `https://chainscan-galileo.0g.ai` |
| Storage | `https://storagescan.0g.ai` | `https://storagescan-galileo.0g.ai` |
| Funding | Real 0G | `https://faucet.0g.ai` |

A full publish of the current 7 skills costs about 0.0000067 0G in storage fees
plus gas for 8 transactions.

## Caution

0G Storage is permanent and public. There is no delete. Anything published here
stays published, so read the dry-run manifest before passing `--confirm`.

## Development

    pnpm test        # Node's built-in runner, offline
    pnpm typecheck   # tsc --noEmit
