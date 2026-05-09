import { getPool } from "./db";

export const listAgentIdsForUser = async (
  userId: string,
): Promise<Set<string>> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_ownership WHERE user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.agent_id));
};

export const registerAgent = async (
  agentId: string,
  userId: string,
): Promise<void> => {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO agent_ownership (agent_id, user_id) VALUES ($1, $2)`,
    [agentId, userId],
  );
};

export const deregisterAgent = async (agentId: string): Promise<void> => {
  const pool = await getPool();
  await pool.query(`DELETE FROM agent_ownership WHERE agent_id = $1`, [
    agentId,
  ]);
};

// Returns `true` when the user owns the agent, otherwise a 404 Response so
// non-owners can't probe whether an agent id exists.
export const assertAgentOwner = async (
  agentId: string,
  userId: string,
): Promise<true | Response> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM agent_ownership WHERE agent_id = $1`,
    [agentId],
  );
  if (rows.length === 0 || rows[0].user_id !== userId) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  return true;
};
