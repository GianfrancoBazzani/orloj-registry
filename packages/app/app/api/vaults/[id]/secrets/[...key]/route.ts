import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertVaultOwner } from "@/lib/vault-ownership";

const initClient = async () => {
  try {
    return { client: await getOneclawClient() } as const;
  } catch (err) {
    console.error("[secrets] 1claw client init failed", err);
    return {
      response: Response.json(
        { error: "Vault service is not configured" },
        { status: 503 },
      ),
    } as const;
  }
};

const resolveKey = (segments: string[] | undefined): string =>
  (segments ?? []).map((s) => decodeURIComponent(s)).join("/");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; key: string[] }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, key } = await params;
  const secretKey = resolveKey(key);
  if (!id || !secretKey) {
    return Response.json(
      { error: "Missing vault id or secret key" },
      { status: 400 },
    );
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  const init = await initClient();
  if ("response" in init) return init.response;

  const { data, error } = await init.client.secrets.get(id, secretKey);
  if (error || !data) {
    console.error("[secrets] 1claw get failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to read secret upstream" },
      { status: 502 },
    );
  }

  const secret = {
    id: data.id,
    key: data.path,
    type: data.type,
    value: data.value,
    version: data.version,
    createdAt: data.created_at,
  };

  return Response.json({ secret });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; key: string[] }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, key } = await params;
  const secretKey = resolveKey(key);
  if (!id || !secretKey) {
    return Response.json(
      { error: "Missing vault id or secret key" },
      { status: 400 },
    );
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  const init = await initClient();
  if ("response" in init) return init.response;

  const { error } = await init.client.secrets.delete(id, secretKey);
  if (error) {
    console.error("[secrets] 1claw delete failed", error);
    return Response.json(
      { error: error.message ?? "Failed to delete secret upstream" },
      { status: 502 },
    );
  }

  return new Response(null, { status: 204 });
}
