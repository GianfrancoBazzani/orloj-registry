import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertAgentOwner } from "@/lib/agent-ownership";
import {
  defaultAppDescription,
  getAgentBranding,
  manifestAppName,
} from "@/lib/agent-branding";
import { listMcpsForAgent } from "@/lib/agent-mcps";
import { fetchMcps } from "@/lib/registry-mcps";

const LOCALES = new Set(["en", "cs", "de", "fr", "es", "zh"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) return new Response("Not found", { status: 404 });

  const client = await getOneclawClient().catch(() => null);
  if (!client) return new Response("Agent service unavailable", { status: 503 });
  const { data: agent, error } = await client.agents.get(id);
  if (error || !agent) return new Response("Not found", { status: 404 });

  const [branding, assignedIds, registry] = await Promise.all([
    getAgentBranding(id),
    listMcpsForAgent(id),
    fetchMcps(),
  ]);
  const url = new URL(request.url);
  const requestedLocale = url.searchParams.get("lang") ?? "en";
  const locale = LOCALES.has(requestedLocale) ? requestedLocale : "en";
  const assigned = new Set(assignedIds);
  const mcpNames = registry
    .filter((mcp) => assigned.has(mcp.id))
    .map((mcp) => mcp.name);
  const name = manifestAppName(agent.name, branding.appName);
  const shortBase = name.replace(/ · Orloj$/u, "");
  const shortName = `${shortBase.slice(0, 14)} · Orloj`;
  const startUrl = `/${locale}/agents/${encodeURIComponent(id)}?source=pwa`;
  const iconBase = `/api/agents/${encodeURIComponent(id)}/icon`;

  return Response.json(
    {
      id: `/agents/${encodeURIComponent(id)}`,
      name,
      short_name: shortName,
      description: defaultAppDescription(agent.name, mcpNames),
      start_url: startUrl,
      scope: `/${locale}/agents/${encodeURIComponent(id)}`,
      display: "standalone",
      background_color: "#f1e9d4",
      theme_color: "#1a1612",
      prefer_related_applications: false,
      icons: [
        {
          src: `${iconBase}/192`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: `${iconBase}/512`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'",
        "Content-Type": "application/manifest+json",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
