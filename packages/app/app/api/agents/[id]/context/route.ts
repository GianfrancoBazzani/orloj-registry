import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { listMcpsForAgent } from "@/lib/agent-mcps";
import { fetchMcps } from "@/lib/registry-mcps";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  const [assignedIds, registry] = await Promise.all([
    listMcpsForAgent(id),
    fetchMcps(),
  ]);
  const assigned = new Set(assignedIds);

  return Response.json(
    {
      runtimeContractVersion: 1,
      agentId: id,
      assignedMcps: registry
        .filter((mcp) => assigned.has(mcp.id))
        .map((mcp) => ({
          id: mcp.id,
          name: mcp.name,
          summary: mcp.summary,
          platform: mcp.platform,
          tokens: mcp.tokens,
          interactionType: mcp.interactionType,
          endpoint: mcp.mcpUrl,
        })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
