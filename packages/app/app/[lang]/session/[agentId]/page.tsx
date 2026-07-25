import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getOneclawClient } from "@/lib/oneclaw";
import { AgentAppBar, AgentAppSignIn } from "@/components/agent-app";
import { SessionView } from "@/components/session/session-view";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ lang: string; agentId: string }>;
}) {
  const { lang, agentId } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  // Signs in here rather than redirecting to /profile: this URL is the installed app's
  // start_url, and sending a standalone window to an out-of-scope page kicks it out of the app.
  if (!session) return <AgentAppSignIn />;

  const ownership = await assertAgentOwner(agentId, session.user.id);
  if (ownership !== true) notFound();

  // The name is cosmetic; a failing upstream must not block the chat.
  let agentName = agentId;
  try {
    const client = await getOneclawClient();
    const { data } = await client.agents.get(agentId);
    if (data?.name) agentName = data.name;
  } catch {
    // fall back to the id
  }

  // This URL is the agent app: it is the manifest's start_url and scope, so it is where the
  // manifest is linked and the only page that can offer the install. Credentialed because the
  // manifest is owner-checked and private.
  // userId comes from the server session rather than useAuth(): the client auth context
  // exposes no user id, and the localStorage transcript key is scoped per user.
  return (
    <>
      <link
        rel="manifest"
        href={`/api/agents/${encodeURIComponent(agentId)}/manifest.webmanifest?lang=${encodeURIComponent(lang)}`}
        crossOrigin="use-credentials"
      />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <AgentAppBar agentId={agentId} lang={lang} />
      <SessionView
        agentId={agentId}
        agentName={agentName}
        userId={session.user.id}
        lang={lang}
      />
    </>
  );
}
