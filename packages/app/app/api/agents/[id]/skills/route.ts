import { MAX_SKILLS } from "@orloj/skills-marketplace/install-plan";
import { readMcpSelection } from "@/lib/session/mcp-block";
import { createSession, sessionForAgent } from "@/lib/session/registry";
import { authorizeAgent, errorResponse } from "@/lib/session/route-helpers";
import { loadIndex } from "@/lib/session/skill-catalog";
import { readInstalledSkills, syncSkills } from "@/lib/session/skill-install";
import { agentDir, configDirExists } from "@/lib/session/zeroclaw-config";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authorized = await authorizeAgent(id);
  if (authorized instanceof Response) return authorized;

  // Guarded on `configured` for the same reason GET /mcps is: a read must never be the thing
  // that creates the agent dir.
  const configured = await configDirExists(id);
  const skills = configured ? await readInstalledSkills(id) : [];
  return Response.json(
    { configured, skills },
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
  const skillNames = (body as { skillNames?: unknown })?.skillNames;
  if (
    !Array.isArray(skillNames) ||
    skillNames.length > MAX_SKILLS ||
    !skillNames.every((n) => typeof n === "string" && n.length > 0 && n.length <= 64)
  ) {
    return Response.json({ error: "Invalid skillNames" }, { status: 400 });
  }

  // The single most load-bearing line here. Installing a skill writes into
  // <agentDir>/agents/default/workspace/skills, which creates <agentDir> as a side effect —
  // and that directory's existence IS the "configured" flag (zeroclaw-config.ts
  // configDirExists). Without this guard, applying skills to an agent that has never been
  // configured would mark it configured-with-no-config: the setup wizard disappears for
  // good and every later session start silently ignores its MCP selection.
  if (!(await configDirExists(id))) {
    return Response.json(
      { error: "Agent has no session yet", code: "not_configured" },
      { status: 409 },
    );
  }

  const live = sessionForAgent(id, userId);
  if (live?.busy) {
    return Response.json({ error: "Session busy", code: "session_busy" }, { status: 409 });
  }

  try {
    const index = await loadIndex();
    // Disk first, respawn second, and the sync is idempotent — so a crash between the two
    // leaves the workspace correct and the next session start picks the skills up anyway.
    const { skills, dropped } = await syncSkills({
      agentId: id,
      requested: skillNames as string[],
      index: index.skills,
    });

    // Respawn is required, not incidental: zeroclaw enumerates the workspace's skills into
    // the system prompt when the session is created, so a live process never notices a new
    // directory. Carrying acpSessionId keeps the conversation, exactly as an MCP apply does.
    //
    // The MCP selection is re-read rather than passed in, which is what keeps the two panels
    // independent: applying skills must not disturb which MCPs are connected. Note
    // createSession takes string[] while readMcpSelection returns McpSelectionItem[].
    const mcpNames = (await readMcpSelection(agentDir(id))).map((m) => m.mcpName);

    const result = await createSession({
      agentId: id,
      userId,
      mcpNames,
      acpSessionId: live?.acpSessionId,
    });

    return Response.json({ ...result, skills, dropped });
  } catch (err) {
    return errorResponse(err);
  }
}
