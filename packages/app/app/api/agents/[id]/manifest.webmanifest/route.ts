import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertAgentOwner } from "@/lib/agent-ownership";
import {
  DEFAULT_ICON_SRC,
  defaultAppDescription,
  defaultIconSizes,
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
  // The installed app opens the chat itself: `/{locale}/session/{id}` is the agent app URL, and
  // `scope` has to contain `start_url`. That scope is also what makes the session page the only
  // page a browser will offer the install from.
  const appUrl = `/${locale}/session/${encodeURIComponent(id)}`;
  const startUrl = `${appUrl}?source=pwa`;
  // Uploads are validated square, so a circular mask is safe on them. The shipped Orloj mark is
  // not square — masking it would clip the rim — so it ships as `any` at its measured size.
  const icons =
    branding.iconPng && branding.iconWidth && branding.iconHeight
      ? [
          {
            src: `/api/agents/${encodeURIComponent(id)}/icon`,
            sizes: `${branding.iconWidth}x${branding.iconHeight}`,
            type: "image/png",
            purpose: "any maskable",
          },
        ]
      : [
          {
            src: DEFAULT_ICON_SRC,
            sizes: await defaultIconSizes(),
            type: "image/png",
            purpose: "any",
          },
        ];

  return Response.json(
    {
      id: `/session/${encodeURIComponent(id)}`,
      name,
      short_name: shortName,
      description: defaultAppDescription(agent.name, mcpNames),
      start_url: startUrl,
      scope: appUrl,
      display: "standalone",
      background_color: "#f1e9d4",
      theme_color: "#1a1612",
      prefer_related_applications: false,
      icons,
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
