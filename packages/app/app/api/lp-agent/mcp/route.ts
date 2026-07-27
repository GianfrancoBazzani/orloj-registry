import { createAppLpAgentDispatcher } from "@/lib/lp-agent-mcp";
import { resolveAgentIdFromRawToken } from "@/lib/mcp-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export async function POST(request: Request) {
  const token = extractBearer(request);
  if (!token) {
    return Response.json(
      { error: "missing_or_malformed_bearer" },
      { status: 401 },
    );
  }

  let agentId: string | null;
  try {
    agentId = await resolveAgentIdFromRawToken(token);
  } catch {
    return Response.json({ error: "token_lookup_failed" }, { status: 500 });
  }
  if (!agentId) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  let dispatcher;
  try {
    dispatcher = createAppLpAgentDispatcher({
      agentId,
      bearerToken: token,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "LP Manager MCP misconfigured";
    // Message is crafted to name env vars only — never values.
    return Response.json({ error: message }, { status: 503 });
  }

  const result = await dispatcher.dispatch(body);
  if (result === null) {
    return new Response(null, { status: 202 });
  }
  return Response.json(result);
}
