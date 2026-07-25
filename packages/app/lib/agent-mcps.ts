import "server-only";

import { getPool } from "@/lib/db";
import { getActiveTokenForAgent } from "@/lib/mcp-tokens";
import { fetchMcps } from "@/lib/registry-mcps";
import { assertAgentOwner } from "@/lib/agent-ownership";

export const MCP_NAME_RE =
  /^(?:uniswap|native_token_chain_id_\d+|\d+_0x[a-fA-F0-9]{40})$/;

export const isValidMcpName = (value: string): boolean =>
  MCP_NAME_RE.test(value);

export async function listMcpsForAgent(agentId: string): Promise<string[]> {
  const pool = await getPool();
  const { rows } = await pool.query<{ mcp_name: string }>(
    `SELECT mcp_name
       FROM agent_mcp_binding
      WHERE agent_id = $1
      ORDER BY mcp_name`,
    [agentId],
  );
  return rows.map((row) => row.mcp_name);
}

export async function listMcpsForAgents(
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const agentId of agentIds) result.set(agentId, []);
  if (agentIds.length === 0) return result;

  const pool = await getPool();
  const { rows } = await pool.query<{ agent_id: string; mcp_name: string }>(
    `SELECT agent_id, mcp_name
       FROM agent_mcp_binding
      WHERE agent_id = ANY($1::text[])
      ORDER BY agent_id, mcp_name`,
    [agentIds],
  );
  for (const row of rows) result.get(row.agent_id)?.push(row.mcp_name);
  return result;
}

export async function assignMcpToAgent(
  agentId: string,
  mcpName: string,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO agent_mcp_binding (agent_id, mcp_name)
     VALUES ($1, $2)
     ON CONFLICT (agent_id, mcp_name) DO NOTHING`,
    [agentId, mcpName],
  );
}

export async function unassignMcpFromAgent(
  agentId: string,
  mcpName: string,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `DELETE FROM agent_mcp_binding
      WHERE agent_id = $1 AND mcp_name = $2`,
    [agentId, mcpName],
  );
}

export async function getAgentRuntimeConfig(
  agentId: string,
  userId: string,
): Promise<{
  agentId: string;
  mcpServers: Array<{
    id: string;
    name: string;
    url: string;
    authorization: string;
  }>;
}> {
  const ownership = await assertAgentOwner(agentId, userId);
  if (ownership !== true) throw new Error("Agent not found");

  const [assignedIds, token, registry] = await Promise.all([
    listMcpsForAgent(agentId),
    getActiveTokenForAgent(agentId),
    fetchMcps(),
  ]);
  if (!token) throw new Error("Agent has no active MCP API key");

  const assigned = new Set(assignedIds);
  return {
    agentId,
    mcpServers: registry
      .filter((mcp) => assigned.has(mcp.id))
      .map((mcp) => ({
        id: mcp.id,
        name: mcp.name,
        url: mcp.mcpUrl,
        authorization: `Bearer ${token}`,
      })),
  };
}
