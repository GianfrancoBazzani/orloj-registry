import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
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
  if (ownership !== true) return ownership;

  let client;
  try {
    client = await getOneclawClient();
  } catch (err) {
    console.error("[vaults] 1claw client init failed", err);
    return Response.json(
      { error: "Vault service is not configured" },
      { status: 503 },
    );
  }

  const { error } = await client.vault.delete(id);
  if (error) {
    console.error("[vaults] 1claw delete failed", error);
    return Response.json(
      { error: error.message ?? "Failed to delete vault upstream" },
      { status: 502 },
    );
  }

  await releaseVault(id);

  return new Response(null, { status: 204 });
}
