import { readMcpSelection } from "@/lib/session/mcp-block";
import { MAX_MCPS } from "@/lib/session/mcp-servers";
import { createSession, sessionForAgent } from "@/lib/session/registry";
import { authorizeAgent, errorResponse } from "@/lib/session/route-helpers";
import { agentDir, configDirExists } from "@/lib/session/zeroclaw-config";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;

  // Never creates the dir: `configured: false` is what makes the page show the wizard.
  if (!(await configDirExists(id))) {
    return Response.json({ configured: false, mcps: [] });
  }
  return Response.json({ configured: true, mcps: await readMcpSelection(agentDir(id)) });
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
