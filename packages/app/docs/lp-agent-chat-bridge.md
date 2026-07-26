# App — Graph LP Manager chat bridge

ZeroClaw chat can invoke **one cycle** of `@orloj/lp-agent` through an app-hosted MCP:

`POST /api/lp-agent/mcp`

## Roles

| Layer | Role |
|---|---|
| ZeroClaw | Conversational supervisor (auto-approves tools — server flags are mandatory) |
| Graph LP Manager MCP | Thin authenticated bridge |
| `@orloj/lp-agent` `runOnce()` | Specialized Graph + 0G inference + guarded Uniswap MCP pipeline |

## Enable

1. Set vars in `packages/app/.env` (see `.env.example`): `LP_AGENT_MCP_URL`, `THE_GRAPH_API_KEY`, `LP_AGENT_AI_*`, `LP_AGENT_STATE_DIR`, `LP_AGENT_CHAT_EXECUTE_ENABLED=false`.
2. Start registry + Next.js app.
3. In the MCP picker, select **Uniswap** and **Graph LP Manager** (`orloj-lp-manager`) for an agent — not auto-granted.
4. Ask chat to analyze positions (observe only). Do not enable execute until audited.

## Invariants

- Incoming Bearer MCP token → `agent_id` (exact match); forwarded only to Orloj Uniswap MCP.
- Mode forced by tool; execute tool omitted unless `LP_AGENT_CHAT_EXECUTE_ENABLED=true`.
- Per-agent state files under `LP_AGENT_STATE_DIR` (hashed agent id). Same-agent concurrency rejected.
- Does not read `packages/lp-agent/.env`.
