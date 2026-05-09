import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { issueTokenForAgent, revokeAllTokensForAgent } from "@/lib/mcp-tokens";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) {
    return ownership;
  }

  try {
    await revokeAllTokensForAgent(id);
    const issued = await issueTokenForAgent(id);
    return Response.json({ api_key: issued.token });
  } catch (err) {
    console.error("[agents] mcp token rotation failed", err);
    return Response.json(
      { error: "Failed to rotate agent key" },
      { status: 500 },
    );
  }
}
