import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertAgentOwner } from "@/lib/agent-ownership";

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

  let client;
  try {
    client = await getOneclawClient();
  } catch (err) {
    console.error("[agents] 1claw client init failed", err);
    return Response.json(
      { error: "Agent service is not configured" },
      { status: 503 },
    );
  }

  const { data, error } = await client.agents.rotateKey(id);

  if (error || !data) {
    console.error("[agents] 1claw rotateKey failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to rotate agent key upstream" },
      { status: 502 },
    );
  }

  return Response.json({ api_key: data.api_key });
}
