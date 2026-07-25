import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getSession, resetSession } from "@/lib/session/registry";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const entry = getSession(id, session.user.id);
  if (!entry) return Response.json({ error: "Session expired" }, { status: 410 });
  if (entry.busy) return Response.json({ error: "Session busy" }, { status: 409 });

  try {
    // session/close then session/new on the SAME process: the client's sessionId does not
    // change, so the chat transport keeps working and only the stored messages are dropped.
    const acpSessionId = await resetSession(id, session.user.id);
    if (!acpSessionId) return Response.json({ error: "Session expired" }, { status: 410 });
    return Response.json({ acpSessionId });
  } catch (err) {
    console.error("[session] reset failed", err);
    return Response.json({ error: "Failed to reset session" }, { status: 500 });
  }
}
