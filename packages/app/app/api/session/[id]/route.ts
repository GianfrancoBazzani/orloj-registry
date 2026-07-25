import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { endSession } from "@/lib/session/registry";

// Idempotent: called best-effort from the chatbox's unmount with `keepalive: true`, so a
// closed tab does not leave a zeroclaw process alive until the sweeper notices.
// (navigator.sendBeacon cannot reach this route — it only issues POST.)
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  endSession(id, session.user.id);
  return Response.json({ ok: true });
}
