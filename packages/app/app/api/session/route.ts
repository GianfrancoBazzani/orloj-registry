import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { readMcpSelection } from "@/lib/session/mcp-block";
import { MAX_MCPS } from "@/lib/session/mcp-servers";
import { createSession } from "@/lib/session/registry";
import { errorResponse } from "@/lib/session/route-helpers";
import { agentDir, configDirExists, InvalidAgentIdError } from "@/lib/session/zeroclaw-config";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { agentId, mcpNames, acpSessionId } = (body ?? {}) as {
    agentId?: unknown;
    mcpNames?: unknown;
    acpSessionId?: unknown;
  };
  if (typeof agentId !== "string") {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  const ownership = await assertAgentOwner(agentId, session.user.id);
  if (ownership !== true) return ownership;
  try {
    agentDir(agentId);
  } catch (err) {
    if (err instanceof InvalidAgentIdError) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    throw err;
  }

  // A malformed id is a 400; an unknown one is not an error at all — it degrades to a fresh
  // session with `resumed: false`.
  if (
    acpSessionId !== undefined &&
    (typeof acpSessionId !== "string" || !UUID_RE.test(acpSessionId))
  ) {
    return Response.json({ error: "Invalid acpSessionId" }, { status: 400 });
  }

  // The stored selection wins for a configured agent, so a stale tab cannot silently
  // rewrite the set — changing it is PUT /api/agents/[id]/mcps's job.
  const configured = await configDirExists(agentId);
  let names: string[];
  if (configured) {
    names = (await readMcpSelection(agentDir(agentId))).map((m) => m.mcpName);
  } else {
    if (
      !Array.isArray(mcpNames) ||
      mcpNames.length > MAX_MCPS ||
      !mcpNames.every((n) => typeof n === "string" && n.length > 0 && n.length <= 128)
    ) {
      return Response.json(
        { error: mcpNames === undefined ? "MCP selection required" : "Invalid mcpNames" },
        { status: 400 },
      );
    }
    names = mcpNames as string[];
  }

  try {
    const result = await createSession({
      agentId,
      userId: session.user.id,
      mcpNames: names,
      acpSessionId: typeof acpSessionId === "string" ? acpSessionId : undefined,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
