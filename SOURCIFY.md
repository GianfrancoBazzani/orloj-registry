# Orloj × Sourcify

> *Built at **ETHPrague 2026**.* An MCP registry built end-to-end on Sourcify-verified contract metadata — turning every Sourcify entry into an AI-callable typed tool.

## The pitch

Orloj turns Sourcify-verified smart contracts into **MCP servers AI agents can call as typed tools**. Every Orloj MCP — its tool list, its parameter types, its function descriptions, its proxy-aware ABI — is generated end-to-end with a Sourcify connection. The moment a contract is verified on Sourcify, it becomes callable by an AI agent through Orloj, with no per-contract integration work on our side.

To our knowledge nobody has built this category of consumer on top of Sourcify before. *Making verified contracts directly executable by LLMs* — a category that didn't exist a year ago — is something Sourcify uniquely enables: it requires the metadata-grade verification, the NatSpec, and the proxy resolution, all together, in one place.

## How we use Sourcify (beyond just "fetch the ABI")

Every MCP we serve is built from **five distinct fields** of the Sourcify v2 contract response, each load-bearing:

| Field               | What we do with it                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **abi**             | Recursively translated into Zod input/output schemas — including tuple types, dynamic arrays, fixed-size arrays, all integer widths, and fixed-size byte types    |
| **userdoc**         | Function "notice" strings (NatSpec) become the tool description an LLM reads when deciding whether to call the function                                           |
| **devdoc**          | Function "details" strings used as a fallback description when no userdoc notice exists                                                                            |
| **compilation**     | The contract name field becomes the MCP server name — agents see "WstETH" or "UniswapV3Pool", not a hex address                                                   |
| **proxyResolution** | Detects proxies at registration time and points the ABI fetch at the implementation, so upgrades are transparent                                                  |

The two requests we make per registration:

1. `GET /v2/contract/{chainId}/{address}?fields=proxyResolution` — proxy detection.
2. `GET /v2/contract/{chainId}/{address}?fields=abi,userdoc,devdoc,compilation` — typed surface + descriptions + name (against the implementation when relevant).

**The NatSpec → tool-description chain is the unique-data argument.** The string that determines whether an agent decides to call a tool is *the contract author's own NatSpec, surfaced verbatim through Sourcify*. You can't do this with a raw ABI from a block explorer — it requires Sourcify's metadata-aware verification. Contract authors are already writing the documentation the agent needs; Sourcify is what makes it reachable, and Orloj is what consumes it.

**Proxies are first-class because Sourcify makes them so.** Most production contracts are proxies; without `proxyResolution`, an agent registry is dead on arrival. We bind agents to the proxy address (the user-facing one) but type the tools off the implementation ABI. Proxy upgrades surface as new MCP tools the next time the registry is refreshed.

## Why this matters

Every verified contract on Sourcify — across 100+ EVM chains — is a candidate Orloj MCP. There is no manual ABI upload, no per-contract integration, no documentation step on our side. The whole pipeline (verified bytecode → ABI → typed MCP tool → NatSpec-described action surfaced to an LLM) flows from one Sourcify request.

This only works because Sourcify is what it is: open data, exact metadata-based matches, NatSpec-aware, and proxy-aware. An agent ecosystem that wants to read and write the chain at scale needs a verification layer it can build on permissionlessly — and Orloj is what becomes possible when you treat that layer as load-bearing public infrastructure.

## Files of interest

- `packages/registry/src/get-contract.js` — Sourcify v2 fetch, multi-field consumption, ABI → Zod, NatSpec → MCP tool descriptions, proxy ABI override
- `packages/registry/src/server.mjs` — `POST /register` proxy-resolution call to `?fields=proxyResolution`
- `packages/registry/src/generate-mcp.js` — turns a fetched contract into an `McpServer` with view/write tools, one per ABI function
