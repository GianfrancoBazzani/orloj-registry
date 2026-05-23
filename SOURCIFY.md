# Orloj × Sourcify

> *Built at **ETHPrague 2026**.* An MCP registry built end-to-end on Sourcify-verified contract metadata — turning every Sourcify entry into an AI-callable typed tool.

## The pitch

Orloj turns Sourcify-verified smart contracts into **MCP servers AI agents can call as typed tools**. Every Orloj MCP — its tool list, its parameter types, its function descriptions, its proxy-aware ABI — is generated end-to-end with a Sourcify connection. The moment a contract is verified on Sourcify, it becomes callable by an AI agent through Orloj, with no per-contract integration work on our side.

To our knowledge nobody has built this category of consumer on top of Sourcify before. *Making verified contracts directly executable by LLMs* — a category that didn't exist a year ago — is something Sourcify uniquely enables: it requires the metadata-grade verification, the ABI, and the proxy resolution, all together, in one place.

## How we use Sourcify (beyond just "fetch the ABI")

Every MCP we serve is built from **three distinct fields** of the Sourcify v2 contract response, each load-bearing:

| Field               | What we do with it                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **abi**             | Parsed at runtime by alloy's `JsonAbi`; every function becomes an MCP tool with inputs/outputs encoded via `DynSolValue` — tuples, dynamic arrays, fixed-size arrays, all integer widths, `bytesN` |
| **compilation**     | The contract name field becomes the MCP server name — agents see "WstETH" or "UniswapV3Pool", not a hex address                                                   |
| **proxyResolution** | Detects proxies at registration time and points the ABI fetch at the implementation, so upgrades are transparent                                                  |

The single request we make per registration:

`GET /v2/contract/{chainId}/{address}?fields=abi,compilation,proxyResolution` — ABI, name, and proxy detection in one call (against the implementation address when a proxy is detected).

**Proxies are first-class because Sourcify makes them so.** Most production contracts are proxies; without `proxyResolution`, an agent registry is dead on arrival. We bind agents to the proxy address (the user-facing one) but type the tools off the implementation ABI. Proxy upgrades surface as new MCP tools the next time the registry is refreshed.

## Why this matters

Every verified contract on Sourcify — across 100+ EVM chains — is a candidate Orloj MCP. There is no manual ABI upload, no per-contract integration, no schema-writing step on our side. The whole pipeline (verified bytecode → ABI → typed MCP tool callable by an LLM) flows from one Sourcify request.

This only works because Sourcify is what it is: open data, exact metadata-based matches, ABI-complete, and proxy-aware. An agent ecosystem that wants to read and write the chain at scale needs a verification layer it can build on permissionlessly — and Orloj is what becomes possible when you treat that layer as load-bearing public infrastructure.

## Files of interest

- `packages/registry/src/sourcify.rs` — Sourcify v2 fetch, proxy detection, implementation ABI override
- `packages/registry/src/abi_codec.rs` — ABI → MCP tool schema (`JsonAbi` → `DynSolValue`), calldata encoding/decoding
- `packages/registry/src/mcps/evm_mcp.rs` — builds the in-memory MCP server with one tool per ABI function (view → `eth_call`, write → signed tx)
- `packages/registry/src/server.rs` — `POST /register` handler
