import { getPool } from "./db.mjs";

const ARGS_CAP = 4096;
const STR_CAP = 500;

function safeArgs(args) {
  try {
    const json = JSON.stringify(args, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    if (json.length > ARGS_CAP) {
      return { _truncated: true, preview: json.slice(0, ARGS_CAP) };
    }
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function logToolCall({
  agentId,
  mcpName,
  contractName,
  toolName,
  args,
  status,
  resultSummary,
  errorMessage,
}) {
  const pool = getPool();
  try {
    console.log(`[metrics] logging ${toolName} for agent ${agentId} on ${mcpName}`);
    const params = [
      agentId,
      mcpName,
      contractName ?? null,
      toolName,
      safeArgs(args),
      status,
      resultSummary ? String(resultSummary).slice(0, STR_CAP) : null,
      errorMessage ? String(errorMessage).slice(0, STR_CAP) : null,
    ];

    await pool.query(
      `INSERT INTO tool_call_log
         (agent_id, user_id, mcp_name, contract_name, tool_name, args,
          status, result_summary, error_message)
       SELECT $1, ao.user_id, $2, $3, $4, $5, $6, $7, $8
         FROM agent_ownership ao WHERE ao.agent_id = $1`,
      params,
    );

    await pool.query(
      `INSERT INTO user_mcp_binding (user_id, mcp_name)
       SELECT ao.user_id, $2 FROM agent_ownership ao WHERE ao.agent_id = $1
       ON CONFLICT (user_id, mcp_name) DO NOTHING`,
      [agentId, mcpName],
    );

    console.log(`[metrics] logged and bound ${mcpName}`);
  } catch (e) {
    console.error("[metrics] logToolCall failed:", e?.message ?? e);
  }
}
