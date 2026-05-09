import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
} from "@/lib/vault-providers";
import { assertVaultOwner, releaseVault } from "@/lib/vault-ownership";

export async function DELETE(
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
    await getProvider(ownership.provider).deleteVault(id);
  } catch (err) {
    return providerErrorToResponse(err);
  }

  await releaseVault(id);

  return new Response(null, { status: 204 });
}
