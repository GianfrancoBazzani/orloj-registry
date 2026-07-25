import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getOneclawClient } from "@/lib/oneclaw";
import { SessionView } from "@/components/session/session-view";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ lang: string; agentId: string }>;
}) {
  const { lang, agentId } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${lang}/profile`);

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

  // userId comes from the server session rather than useAuth(): the client auth context
  // exposes no user id, and the localStorage transcript key is scoped per user.
  return (
    <SessionView
      agentId={agentId}
      agentName={agentName}
      userId={session.user.id}
      lang={lang}
    />
  );
}
