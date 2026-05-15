# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Rust MCP registry server. Given a contract address and chain ID it fetches the ABI from Sourcify (once, then persists to Postgres), builds an in-memory MCP server with one tool per ABI function, and routes `POST /interface/:name/mcp` requests to it.

Key behaviors:
- **Lazy loading + idle eviction** — MCPs build on first request; idle for 30 min → evicted, rebuilt on next access
- **Proxy contract support** — detects proxy via Sourcify `proxyResolution`, fetches implementation ABI, generates tools from it, but all calls target the proxy address
- **Vault-per-agent signing** — write calls resolve the agent's vault (Orbitport KMS or 1Claw) from Postgres; no static keys

## Source layout

```
src/
  main.rs                  # binary entry: env, DB connect, pre-warm registry, start axum
  lib.rs                   # crate root — re-exports modules
  abi_codec.rs             # ABI ↔ JSON: input_schema, json_to_dyn_args, dyn_outputs_to_json
  auth.rs                  # require_bearer: Bearer token → agent_id via mcp_api_key table
  db.rs                    # DbPool (sqlx PgPool + vault cache): contract CRUD, auth, vault resolution, tool call logging
  registry.rs              # Arc<RwLock<HashMap>> registry with idle eviction background task
  server.rs                # axum router: /healthz, /mcp, /register, /register-native, /interface/:name/mcp
  sourcify.rs              # fetch_contract(): Sourcify API, proxy detection + impl ABI fetch
  mcps/
    mod.rs
    evm_mcp.rs             # EvmMcpServer<P>: list_tools, call_tool, dispatch (JSON-RPC), build_tools
    native_mcp.rs          # NativeMcpServer: balanceOf, transfer for native currency
  vault/
    mod.rs
    sign_transaction.rs    # sign_transaction(): Orbitport KMS path + 1Claw path, oneclaw_bearer_token
```

## Build and run

```bash
cargo build
cargo run --bin orloj-backend-rust
cargo check                          # fast type-check without linking
```

## Key dependencies

- **rmcp 0.16.0** — MCP protocol. Dynamic tools (ABI-driven) implement `ServerHandler` directly — no macros. Static tools use `#[tool_router]` / `#[tool]`.
- **alloy 2.0.4** — EVM. `JsonAbi` (`json-abi` feature) for runtime ABI parsing; `DynSolValue` (`dyn-abi` feature) for calldata encoding/decoding. Use `alloy::hex` — do **not** add a separate `hex` crate.
- **axum 0.7** — HTTP server.
- **sqlx 0.8** — Postgres, async, with `json` feature for JSONB columns.

## ABI → MCP tool mapping

**Input schema** (`abi_codec::input_schema`): every ABI parameter maps to `"type": "string"` in JSON Schema. The Solidity type goes in `"description"`. Write functions get an extra optional `native_gas_token_value` field (wei as decimal string) for the ETH amount to send with the transaction.

**Encoding** (`abi_codec::json_to_dyn`): string JSON inputs → correct `DynSolValue`:
- `address` — checksum or lowercase hex string
- `bool` — JSON boolean
- `uint*` / `int*` — decimal string
- `bytes` / `bytesN` — `0x`-prefixed hex string
- `tuple` — JSON object, fields matched by component name
- `T[]` / `T[N]` — JSON array, items recursed

**Decoding** (`abi_codec::dyn_outputs_to_json`): `DynSolValue` → JSON. Integers → decimal strings, addresses → EIP-55 checksum, bytes → `0x`-prefixed hex.

`view` / `pure` → `eth_call`. `nonpayable` / `payable` → signed transaction via vault.

## Proxy contract flow

`sourcify::fetch_contract` queries `?fields=abi,userdoc,devdoc,compilation,proxyResolution`. If `proxyResolution.isProxy` is true and `proxyResolution.implementations[0].address` is present, it makes a second Sourcify call for the implementation's ABI and returns that. The stored ABI is the implementation's; `McpEntry.address` (the proxy) is used for all on-chain calls.

## Vault signing flow

`db::DbPool::resolve_vault(agent_id)` (with in-memory cache):
1. **Orbitport** — `orbitport_grant JOIN orbitport_vault WHERE agent_id = $1`. If found: build EIP-1559 tx, send digest to Orbitport KMS (`/kms/sign`), reassemble `r/s/yParity` from the 65-byte response.
2. **1Claw** — `agent_ownership → user_id → vault_ownership WHERE provider='oneclaw' → vaultId` → `listGrants` → `signingKeyPath` → `secrets.get` → private key → sign locally with alloy `PrivateKeySigner`.

## Auth flow

`POST /interface/:name/mcp` requires `Authorization: Bearer <token>`. `auth::require_bearer` queries `mcp_api_key WHERE token = $1 AND revoked_at IS NULL` using constant-time comparison, returns `agent_id`.

## Registry design

`Registry` wraps `Arc<RwLock<HashMap<String, Arc<McpEntry>>>>`. Each `McpEntry` tracks `last_used: Mutex<Instant>`. A background `tokio::spawn` loop checks every 60 s and evicts entries idle > 30 min. On cache miss, `get_or_load` reads from DB and rebuilds in memory.

Entry keys: `{chain_id}_{address}` for contracts, `native_token_chain_id_{chain_id}` for native tokens.
