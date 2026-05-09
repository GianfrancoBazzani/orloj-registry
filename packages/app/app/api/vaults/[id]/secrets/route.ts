import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertVaultOwner } from "@/lib/vault-ownership";

const KEY_MAX = 256;
const VALUE_MAX = 65536;
const TYPE_MAX = 64;

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "Missing vault id" }, { status: 400 });
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  const init = await initClient();
  if ("response" in init) return init.response;

  const { data, error } = await init.client.secrets.list(id);
  if (error || !data) {
    console.error("[secrets] 1claw list failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to list secrets upstream" },
      { status: 502 },
    );
  }

  const secrets = data.secrets.map((s) => ({
    id: s.id,
    key: s.path,
    type: s.type,
    version: s.version,
    createdAt: s.created_at,
  }));

  return Response.json({ secrets });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "Missing vault id" }, { status: 400 });
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { key, value, type } = body as Record<string, unknown>;

  if (typeof key !== "string" || typeof value !== "string") {
    return Response.json(
      { error: "`key` and `value` must be strings" },
      { status: 400 },
    );
  }
  if (type !== undefined && typeof type !== "string") {
    return Response.json(
      { error: "`type` must be a string when provided" },
      { status: 400 },
    );
  }

  const trimmedKey = key.trim();
  if (trimmedKey.length === 0 || trimmedKey.length > KEY_MAX) {
    return Response.json(
      { error: `\`key\` must be 1–${KEY_MAX} characters` },
      { status: 400 },
    );
  }
  if (value.length === 0 || value.length > VALUE_MAX) {
    return Response.json(
      { error: `\`value\` must be 1–${VALUE_MAX} characters` },
      { status: 400 },
    );
  }
  if (type && type.length > TYPE_MAX) {
    return Response.json(
      { error: `\`type\` must be ≤ ${TYPE_MAX} characters` },
      { status: 400 },
    );
  }

  const init = await initClient();
  if ("response" in init) return init.response;

  const { data, error } = await init.client.secrets.set(
    id,
    trimmedKey,
    value,
    type ? { type } : undefined,
  );

  if (error || !data) {
    console.error("[secrets] 1claw set failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to set secret upstream" },
      { status: 502 },
    );
  }

  const secret = {
    id: data.id,
    key: data.path,
    type: data.type,
    version: data.version,
    createdAt: data.created_at,
  };

  return Response.json({ secret }, { status: 201 });
}
