import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";

const RECENT_LIMIT = 25;

interface ToolCallRow {
  occurred_at: Date;
  agent_id: string;
  mcp_name: string;
  contract_name: string | null;
  tool_name: string;
  args: unknown;
  status: "ok" | "error";
  result_summary: string | null;
  error_message: string | null;
}

function chainIdFromMcpName(name: string): number | null {
  const native = /^native_token_chain_id_(\d+)$/.exec(name);
  if (native) return Number(native[1]);
  const contract = /^(\d+)-0x[a-fA-F0-9]{40}$/.exec(name);
  if (contract) return Number(contract[1]);
  return null;
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const pool = await getPool();

  const [last30, prior30, bindings, recent] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM tool_call_log
        WHERE user_id = $1
          AND occurred_at >= now() - interval '30 days'`,
      [userId],
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM tool_call_log
        WHERE user_id = $1
          AND occurred_at >= now() - interval '60 days'
          AND occurred_at <  now() - interval '30 days'`,
      [userId],
    ),
    pool.query<{ mcp_name: string }>(
      `SELECT mcp_name FROM user_mcp_binding WHERE user_id = $1`,
      [userId],
    ),
    pool.query<ToolCallRow>(
      `SELECT occurred_at, agent_id, mcp_name, contract_name, tool_name,
              args, status, result_summary, error_message
         FROM tool_call_log
        WHERE user_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [userId, RECENT_LIMIT],
    ),
  ]);

  const boundMcps = bindings.rows.map((r) => r.mcp_name);
  const chainsCovered = new Set(
    boundMcps
      .map(chainIdFromMcpName)
      .filter((c): c is number => c !== null),
  ).size;

  return Response.json({
    toolCallsLast30Days: Number(last30.rows[0]?.count ?? 0),
    toolCallsPrior30Days: Number(prior30.rows[0]?.count ?? 0),
    mcpsBound: boundMcps.length,
    chainsCovered,
    boundMcps,
    recentActivity: recent.rows.map((r) => ({
      occurredAt: r.occurred_at.toISOString(),
      agentId: r.agent_id,
      mcpName: r.mcp_name,
      contractName: r.contract_name,
      toolName: r.tool_name,
      status: r.status,
      args: r.args,
      resultSummary: r.result_summary,
      errorMessage: r.error_message,
    })),
  });
}
