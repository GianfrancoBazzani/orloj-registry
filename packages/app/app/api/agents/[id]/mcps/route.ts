import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import {
  assignMcpToAgent,
  isValidMcpName,
  listMcpsForAgent,
  unassignMcpFromAgent,
} from "@/lib/agent-mcps";
import { fetchMcps } from "@/lib/registry-mcps";

async function authorize(id: string): Promise<true | Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return assertAgentOwner(id, session.user.id);
}

async function readMcpName(request: Request): Promise<string | Response> {
  const body = (await request.json().catch(() => null)) as
    | { mcpName?: unknown }
    | null;
  if (
    typeof body?.mcpName !== "string" ||
    !isValidMcpName(body.mcpName)
  ) {
    return Response.json({ error: "Invalid mcpName" }, { status: 400 });
  }
  return body.mcpName;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownership = await authorize(id);
  if (ownership !== true) return ownership;
  return Response.json(
    { mcps: await listMcpsForAgent(id) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownership = await authorize(id);
  if (ownership !== true) return ownership;
  const mcpName = await readMcpName(request);
  if (mcpName instanceof Response) return mcpName;

  const registry = await fetchMcps();
  if (registry.length === 0) {
    return Response.json(
      { error: "MCP registry is unavailable" },
      { status: 503 },
    );
  }
  if (!registry.some((mcp) => mcp.id === mcpName)) {
    return Response.json({ error: "MCP not found" }, { status: 404 });
  }

  await assignMcpToAgent(id, mcpName);
  return Response.json({ ok: true, mcpName }, { status: 201 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownership = await authorize(id);
  if (ownership !== true) return ownership;
  const mcpName = await readMcpName(request);
  if (mcpName instanceof Response) return mcpName;
  await unassignMcpFromAgent(id, mcpName);
  return Response.json({ ok: true, mcpName });
}
