import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getAgentBranding } from "@/lib/agent-branding";
import { listMcpsForAgent } from "@/lib/agent-mcps";
import { fetchMcps } from "@/lib/registry-mcps";
import { AgentApp, AgentAppSignIn } from "@/components/agent-app";

export default async function AgentAppPage({
  params,
}: {
  params: Promise<{ lang: string; id: string }>;
}) {
  const { lang, id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return <AgentAppSignIn />;

  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) notFound();

  const client = await getOneclawClient().catch(() => null);
  if (!client) notFound();
  const { data: agent, error } = await client.agents.get(id);
  if (error || !agent) notFound();

  const [branding, assignedIds, registry] = await Promise.all([
    getAgentBranding(id),
    listMcpsForAgent(id),
    fetchMcps(),
  ]);
  const assigned = new Set(assignedIds);
  const mcps = registry
    .filter((mcp) => assigned.has(mcp.id))
    .map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      summary: mcp.summary,
      platform: mcp.platform,
      tokens: mcp.tokens,
      interactionType: mcp.interactionType,
    }));

  return (
    <>
      <link
        rel="manifest"
        href={`/api/agents/${encodeURIComponent(id)}/manifest.webmanifest?lang=${encodeURIComponent(lang)}`}
        crossOrigin="use-credentials"
      />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <AgentApp
        agentId={id}
        agentName={agent.name}
        customAppName={branding.appName}
        hasCustomIcon={Boolean(branding.iconPng)}
        mcps={mcps}
      />
    </>
  );
}
