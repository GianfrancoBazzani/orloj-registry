import {
  assignMcpToAgent,
  isValidMcpName,
  listMcpsForAgent,
  unassignMcpFromAgent,
} from "@/lib/agent-mcps";
import { fetchMcps } from "@/lib/registry-mcps";
import { readMcpSelection } from "@/lib/session/mcp-block";
import { MAX_MCPS } from "@/lib/session/mcp-servers";
import { createSession, sessionForAgent } from "@/lib/session/registry";
import { authorizeAgent, errorResponse } from "@/lib/session/route-helpers";
import { agentDir, configDirExists } from "@/lib/session/zeroclaw-config";

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
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;

  // Two different sets, and the chat needs both. `mcps` is what the live config.toml grants —
  // never creates the dir, because `configured: false` is what makes the page show the wizard.
  // `assigned` is the marketplace binding the registry authorizes against, so the wizard can
  // start from what the user already assigned instead of an empty list.
  const configured = await configDirExists(id);
  const [mcps, assigned] = await Promise.all([
    configured ? readMcpSelection(agentDir(id)) : Promise.resolve([]),
    listMcpsForAgent(id),
  ]);
  return Response.json(
    { configured, mcps, assigned },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;
  const { userId } = authorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const mcpNames = (body as { mcpNames?: unknown })?.mcpNames;
  if (
    !Array.isArray(mcpNames) ||
    mcpNames.length > MAX_MCPS ||
    !mcpNames.every((n) => typeof n === "string" && n.length > 0 && n.length <= 128)
  ) {
    return Response.json({ error: "Invalid mcpNames" }, { status: 400 });
  }

  // Respawn is required, not incidental: config.toml is read at process start and
  // acp_enable_mcp initializes bundle tools at session/new, so a live process will never
  // notice a rewritten block. The live acpSessionId rides along so the thread can resume —
  // probing confirmed session/load re-initializes the bundle tools.
  const live = sessionForAgent(id, userId);
  if (live?.busy) return Response.json({ error: "Session busy" }, { status: 409 });
  const carry = live?.acpSessionId;

  try {
    const result = await createSession({
      agentId: id,
      userId,
      mcpNames: mcpNames as string[],
      acpSessionId: carry,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;
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
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;
  const mcpName = await readMcpName(request);
  if (mcpName instanceof Response) return mcpName;
  await unassignMcpFromAgent(id, mcpName);
  return Response.json({ ok: true, mcpName });
}
