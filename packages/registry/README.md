# orloj-backend-rust

Rust MCP registry server. Registers EVM smart contracts and native tokens as MCP servers, routing `POST /interface/:name/mcp` requests to in-memory MCP handlers backed by on-chain calls.

## Features

- **Contract MCPs** — one MCP tool per ABI function; read functions call `eth_call`, write functions sign and broadcast transactions
- **Proxy contract support** — automatically detects proxy contracts via Sourcify `proxyResolution`, fetches the implementation ABI, and generates tools from it while calling the proxy address
- **Native token MCPs** — `balanceOf` / `transfer` for any EVM chain's native currency
- **Uniswap MCP** — swaps on any registered chain via the Trading API, plus Uniswap V3 liquidity-position management on Ethereum Sepolia via the Liquidity API ([details](#uniswap-mcp))
- **Lazy loading + idle eviction** — MCPs load on first request; entries idle for 30 min are evicted and rebuilt on next access
- **Vault-per-agent signing** — write calls resolve the agent's signing vault (Orbitport KMS or 1Claw) from Postgres; no static private keys

## Build

```bash
cargo build
cargo check   # fast type-check only
```

## Run

```bash
cargo run
```

Reads configuration from `.env` if present (via `dotenvy`).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `PORT` | no | `3001` | HTTP listen port |
| `ORBITPORT_API_URL` | if Orbitport used | `https://api.spacecomputer.io` | Orbitport API base URL |
| `ORBITPORT_AUTH_URL` | if Orbitport used | `https://auth.spacecomputer.io` | Orbitport OAuth token endpoint |
| `ORBITPORT_AUDIENCE` | if Orbitport used | `https://api.spacecomputer.io` | Orbitport OAuth audience |
| `ORBITPORT_CLIENT_ID` | if Orbitport used | — | Orbitport OAuth client ID |
| `ORBITPORT_CLIENT_SECRET` | if Orbitport used | — | Orbitport OAuth client secret |
| `ONECLAW_API_KEY` | if 1Claw used | — | 1Claw API key |
| `ONECLAW_BASE_URL` | no | `https://api.1claw.xyz` | 1Claw API base URL |
| `UNISWAP_API_KEY` | for the Uniswap MCP | — | Uniswap API key, shared by both Uniswap APIs |
| `UNISWAP_API_URL` | no | `https://trade-api.gateway.uniswap.org/v1` | Uniswap **Trading** API base URL (swaps) |
| `UNISWAP_LP_API_URL` | no | `https://liquidity.api.uniswap.org` | Uniswap **Liquidity** API base URL (V3 LP positions) |

## HTTP API

### `GET /healthz`
Returns `{ ok: true, count: N }` where N is the number of loaded MCP entries.

### `GET /mcp`
Lists all registered MCPs with metadata (name, chainId, address, contractName, toolCount, url).

### `POST /register`
Register a contract and build its MCP.

```json
{ "chainId": 1, "address": "0x...", "rpcUrl": "https://..." }
```

- Calls Sourcify once to fetch the ABI (and resolve proxies). Subsequent calls load from DB.
- For proxy contracts, the implementation ABI is fetched automatically and stored; all calls target the proxy address.

### `POST /register-native`
Register a native-token MCP for a chain.

```json
{ "chainId": 1, "rpcUrl": "https://..." }
```

### `POST /interface/:name/mcp`
Dispatch an MCP JSON-RPC request. Requires `Authorization: Bearer <token>`.

The `name` format is `{chainId}_{address}` for contracts and `native_token_chain_id_{chainId}` for native tokens.

### `POST /interface/uniswap/mcp`
Fixed route for the Uniswap MCP — see below. Not registry-backed, always available.

## Uniswap MCP

A single MCP at `/interface/uniswap/mcp` wrapping **two different Uniswap services**. They have
separate base URLs and separate request shapes, and share only the `UNISWAP_API_KEY`:

| | Trading API | Liquidity API |
|---|---|---|
| Base URL | `https://trade-api.gateway.uniswap.org/v1` | `https://liquidity.api.uniswap.org` |
| Override | `UNISWAP_API_URL` | `UNISWAP_LP_API_URL` |
| Purpose | Swaps | Uniswap V3 liquidity positions |
| Chains | any chain in the `networks` table | **Ethereum Sepolia (11155111) only** |
| Tools | `quote`, `swap`, `supported_networks` | `get_v3_position`, `create_v3_position`, `decrease_v3_position`, `claim_v3_fees` |

**Every write tool signs and broadcasts automatically** and waits for the transaction to confirm.
Callers never supply a wallet address, a private key, or an `rpc_url` — the wallet is resolved
from the authenticated agent's vault and the RPC endpoint from the `networks` table. There is no
separate approval or submission step to call.

### Liquidity tools (Sepolia only)

Uniswap **V3** only — not V2, not V4. Any `chainId` other than `11155111` is rejected up front.
Contracts used, both verified on-chain rather than copied from a doc page:

| Contract | Address |
|---|---|
| `UniswapV3Factory` | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| `NonfungiblePositionManager` | `0x1238536071E1c677A632429e3655c799b22cDA52` |

> Some sources quote `0x3B5E3c5E595D85fbFBC2a42ECC091e183E76697C` as Sepolia's position manager.
> It is not one — on-chain that address is a Solidity library, and `ownerOf`/`positions` revert on
> it. A unit test pins the correct address.

Every liquidity tool refuses to act on a position NFT the agent's wallet does not own.

| Tool | Arguments | Effect |
|---|---|---|
| `get_v3_position` | `chainId`, `nftTokenId` | **Read-only.** Returns pool, token pair, fee tier, tick range, liquidity and `tokensOwed0`/`tokensOwed1`. Pure on-chain reads — no Uniswap API call, so this works with only an RPC endpoint. See the caveat on `tokensOwed` below. |
| `create_v3_position` | `chainId`, `poolAddress`, `independentTokenAddress`, `independentTokenAmount`, `tickLower`, `tickUpper`, `slippageTolerance?` | Opens a position in an **existing** pool (it cannot create pools). Runs any required approvals first and waits for each. Returns the transaction hash and the minted NFT's token id. |
| `decrease_v3_position` | `chainId`, `nftTokenId`, `liquidityPercentageToDecrease`, `slippageTolerance?` | Withdraws liquidity; `100` closes the position out. **Also collects accrued fees** — see below. Does **not** open a replacement position. |
| `claim_v3_fees` | `chainId`, `nftTokenId` | Takes accrued trading fees while leaving liquidity in place — for harvesting from a position you intend to keep open. |

`decrease` and `claim` withdraw any ETH side as WETH.

#### `decrease` collects fees too

The transaction Uniswap returns for a decrease is a `multicall` of `decreaseLiquidity` followed by
an uncapped `collect()` (`amount0Max`/`amount1Max` set to `uint128` max), so it sweeps the freed
principal **and every fee owed** in one go. There is no need to call `claim_v3_fees` first to
"collect fees before withdrawing", and calling it after a decrease will usually find nothing left.
`claim_v3_fees` is for taking fees from a position you are *keeping*.

**The returned amounts do not include those fees.** Uniswap reports the principal being withdrawn,
not the fees swept alongside it, so the wallet can receive materially more than the reported
figures. Verified against position #1 on Sepolia: a 25% decrease reported `token0: 0`, while
`claim_fees` on the same position reported `token0: 12481004647056319871` — that token was
collected, but does not appear in the decrease response at all.

#### `tokensOwed0` / `tokensOwed1` are not live fee balances

`get_v3_position` reports these straight from `positions()`, and they are easy to misread. They
are a **cached** balance written the last time the position was touched on-chain — mint, increase,
decrease or collect — and they exclude everything accrued since. For a position nobody has touched
in a while they are stale, and frequently read zero while real fees are owed. Computing live
claimable fees means reading the pool's and ticks' fee-growth accumulators, which these tools do
not do.

`create_v3_position` deliberately does **not** take `token0Address`/`token1Address`. It reads the
pair off the pool and verifies the pool against the factory. Accepting both a pool and a token
pair from the caller would let a client pair a genuine pool with unrelated token addresses and get
approvals issued against the wrong assets.

### What is checked before anything is signed

Every transaction the Liquidity API returns is validated and then dry-run with `eth_call` —
including each approval, so a reverting one is caught before it costs gas and leaves the flow
half-done. API calldata is never rewritten.

- **Destination is pinned.** The `create`, `decrease` and `claim` transactions must be addressed
  to the Sepolia `NonfungiblePositionManager`; any other destination is refused. Approvals are
  exempt from the pin, since an approval's destination is legitimately the ERC-20 being approved.
- **`from` must be the agent's own wallet**, and **`chainId` must be 11155111**.
- **Calldata must be non-empty** — every LP operation is a contract call, so a bare value transfer
  would be a silent loss.
- **Token pairs are re-checked against chain state.** The pair the API reports must equal the pair
  read on-chain — from the pool for `create`, from the position NFT for `decrease` and `claim`.
  Those addresses decide which tokens get approved for spending and are reported back as the
  settled result, so they are not taken on trust. Amounts must be plain decimal integers.

Errors name the stage that failed — `position read`, `API request`, `approval`, `simulation`,
`broadcast` or `receipt`. If approvals were already broadcast before a later failure, their
transaction hashes are included in the error.

### Setup for the liquidity tools

1. `UNISWAP_API_KEY` set (the read-only `get_v3_position` does not need it).
2. A Sepolia row in the `networks` table with a working `rpc_url` (seeded by `seed_networks` in
   `main.rs`).
3. An agent with an `mcp_api_key` and a vault (Orbitport or 1Claw).
4. **That vault's Sepolia address funded** — ETH for gas, plus the ERC-20s being deposited.
   Writes will otherwise fail at the simulation or approval stage.

## Database

The server creates its table on startup if it doesn't exist:

```sql
CREATE TABLE registered_contracts (
    chain_id      INTEGER      NOT NULL,
    address       TEXT         NOT NULL,
    implementation TEXT,
    rpc_url       TEXT,
    abi           JSONB        NOT NULL,
    contract_name TEXT         NOT NULL,
    registered_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address)
);
```

Auth, vault resolution, and tool call logging also rely on these tables (managed externally):
- `mcp_api_key` — Bearer token → `agent_id`
- `orbitport_grant`, `orbitport_vault` — Orbitport vault bindings
- `agent_ownership`, `vault_ownership` — 1Claw vault bindings
- `tool_call_log`, `user_mcp_binding` — usage metrics
