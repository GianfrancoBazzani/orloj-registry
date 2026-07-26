# Orloj × Uniswap

> *Built at **ETHPrague 2026**.* A multichain Uniswap MCP that lets an AI agent quote, swap and run V3 liquidity positions with no keys, no RPCs and no transaction plumbing.

## The pitch

Orloj turns smart contracts into MCP servers AI agents call as typed tools. On top of that generic machinery we hand-wrote one special server: **a multichain Uniswap MCP** that exposes Uniswap as pure application-layer intent.

The agent says *"swap 20 USDC for ETH on Base"* or *"open a 10%-wide UNI/WETH position with at most 0.01 ETH"*. That's the whole interface. Everything underneath — wallet resolution, RPC selection, token decimals, Permit2, ERC-20 approvals, ETH wrapping, tick math, gas, nonces, signing, broadcasting, receipt polling — is handled by Orloj's infrastructure. **The agent never sees a private key, an RPC URL, a wallet address or an unsigned transaction.** 

## What the MCP exposes

Nine tools, one server, `chainId` explicit on every call so a token address is never ambiguous across networks.

| Tool | Service | Chains | What it does |
| --- | --- | --- | --- |
| `supported_networks` | — | all | Lists chainIds with an RPC registered — the agent discovers its own reach |
| `quote` | Trading API | any registered chain | Pricing + routing, no side effects |
| `swap` | Trading API | any registered chain | Quote → both Permit2 layers if needed → sign → broadcast → confirm |
| `get_v3_pool_state` | on-chain | Sepolia | Live pair, fee tier, tick, sqrt price, tick spacing, active liquidity, verified against the V3 factory |
| `get_v3_position` / `list_v3_positions` | on-chain | Sepolia | Read one position, or every position the agent's wallet holds |
| `create_v3_position` | Liquidity API | Sepolia | Opens a V3 position in an existing pool |
| `decrease_v3_position` | Liquidity API | Sepolia | Withdraws principal *and* sweeps fees in one multicall |
| `claim_v3_fees` | Liquidity API | Sepolia | Harvests fees, leaves liquidity in place |

Two distinct Uniswap services are wrapped, not one: the **Trading API** (`trade-api.gateway.uniswap.org/v1`) for swaps on any chain Orloj has registered, and the separate **Liquidity API** (`liquidity.api.uniswap.org`) for V3 positions. Multichain is real — `chainId` is a required argument rather than a deploy-time constant, so a single MCP endpoint serves every network in the registry.
