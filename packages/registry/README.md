# orloj-backend-rust

Rust MCP registry server. Registers EVM smart contracts and native tokens as MCP servers, routing `POST /interface/:name/mcp` requests to in-memory MCP handlers backed by on-chain calls.

## Features

- **Contract MCPs** — one MCP tool per ABI function; read functions call `eth_call`, write functions sign and broadcast transactions
- **Proxy contract support** — automatically detects proxy contracts via Sourcify `proxyResolution`, fetches the implementation ABI, and generates tools from it while calling the proxy address
- **Native token MCPs** — `balanceOf` / `transfer` for any EVM chain's native currency
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
