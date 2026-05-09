import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
} from "@/lib/vault-providers";
import { assertVaultOwner } from "@/lib/vault-ownership";

const KEY_MAX = 256;
const VALUE_MAX = 65536;
const TYPE_MAX = 64;

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
  if (ownership instanceof Response) return ownership;

  try {
    const records = await getProvider(ownership.provider).listSecrets(id);
    return Response.json({ secrets: records });
  } catch (err) {
    return providerErrorToResponse(err);
  }
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
  if (ownership instanceof Response) return ownership;

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

  try {
    const secret = await getProvider(ownership.provider).setSecret(id, {
      key: trimmedKey,
      value,
      type,
    });
    return Response.json({ secret }, { status: 201 });
  } catch (err) {
    return providerErrorToResponse(err);
  }
}
