import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getAgentBranding } from "@/lib/agent-branding";

// Serves the owner's uploaded icon only. With no upload the manifest points at the static
// Orloj mark instead, so there is nothing for this route to fall back to.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) return new Response("Not found", { status: 404 });

  const branding = await getAgentBranding(id);
  if (!branding.iconPng) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(branding.iconPng), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
