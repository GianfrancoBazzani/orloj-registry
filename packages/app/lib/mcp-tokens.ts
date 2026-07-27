import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";

const TOKEN_PREFIX = "mcpk_live_";
const PREFIX_DISPLAY_LEN = 16;

export const generateMcpToken = (): string =>
  `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;

export type IssuedToken = {
  id: string;
  token: string;
  tokenPrefix: string;
};

export const issueTokenForAgent = async (
  agentId: string,
): Promise<IssuedToken> => {
  const pool = await getPool();
  const id = randomUUID();
  const token = generateMcpToken();
  const tokenPrefix = token.slice(0, PREFIX_DISPLAY_LEN);
  await pool.query(
    `INSERT INTO mcp_api_key (id, agent_id, token, token_prefix)
     VALUES ($1, $2, $3, $4)`,
    [id, agentId, token, tokenPrefix],
  );
  return { id, token, tokenPrefix };
};

export const getActiveTokenForAgent = async (
  agentId: string,
): Promise<string | null> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ token: string }>(
    `SELECT token
       FROM mcp_api_key
      WHERE agent_id = $1
        AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [agentId],
  );
  return rows[0]?.token ?? null;
};

/**
 * Resolve an active (non-revoked) raw MCP bearer token to its Orloj agent_id.
 * Exact token match only — never authenticate by token_prefix.
 */
export const resolveAgentIdFromRawToken = async (
  rawToken: string,
): Promise<string | null> => {
  if (typeof rawToken !== "string" || rawToken.trim() === "") return null;
  const token = rawToken.trim();
  const pool = await getPool();
  const { rows } = await pool.query<{ agent_id: string; token: string }>(
    `SELECT agent_id, token
       FROM mcp_api_key
      WHERE token = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  const a = Buffer.from(row.token, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.agent_id;
};

export const revokeAllTokensForAgent = async (
  agentId: string,
): Promise<number> => {
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE mcp_api_key
        SET revoked_at = now()
      WHERE agent_id = $1
        AND revoked_at IS NULL`,
    [agentId],
  );
  return result.rowCount ?? 0;
};
