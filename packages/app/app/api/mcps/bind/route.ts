import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";

const MCP_NAME_RE = /^(?:native_token_chain_id_\d+|\d+-0x[a-fA-F0-9]{40})$/;

async function readMcpName(request: Request): Promise<string | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const { mcpName } = body as Record<string, unknown>;
  if (typeof mcpName !== "string" || !MCP_NAME_RE.test(mcpName)) {
    return Response.json({ error: "Invalid mcpName" }, { status: 400 });
  }
  return mcpName;
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await readMcpName(request);
  if (result instanceof Response) return result;

  const pool = await getPool();
  await pool.query(
    `INSERT INTO user_mcp_binding (user_id, mcp_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, mcp_name) DO NOTHING`,
    [session.user.id, result],
  );

  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await readMcpName(request);
  if (result instanceof Response) return result;

  const pool = await getPool();
  await pool.query(
    `DELETE FROM user_mcp_binding WHERE user_id = $1 AND mcp_name = $2`,
    [session.user.id, result],
  );

  return Response.json({ ok: true });
}
