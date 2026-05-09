import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
} from "@/lib/vault-providers";
import { assertVaultOwner } from "@/lib/vault-ownership";

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
  if (ownership instanceof Response) return ownership;

  try {
    const secret = await getProvider(ownership.provider).getSecret(id, secretKey);
    return Response.json({ secret });
  } catch (err) {
    return providerErrorToResponse(err);
  }
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
  if (ownership instanceof Response) return ownership;

  try {
    await getProvider(ownership.provider).deleteSecret(id, secretKey);
    return new Response(null, { status: 204 });
  } catch (err) {
    return providerErrorToResponse(err);
  }
}
