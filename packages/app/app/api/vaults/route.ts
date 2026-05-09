import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import {
  claimVault,
  listVaultIdsForUser,
} from "@/lib/vault-ownership";
import type { Vault } from "@/components/data";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const [ownedIds, listResult] = await Promise.all([
    listVaultIdsForUser(session.user.id),
    client.vault.list(),
  ]);

  const { data, error } = listResult;
  if (error || !data) {
    console.error("[vaults] 1claw list failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to list vaults upstream" },
      { status: 502 },
    );
  }

  const owned = data.vaults.filter((v) => ownedIds.has(v.id));

  const counts = await Promise.all(
    owned.map(async (v) => {
      const res = await client.secrets.list(v.id);
      if (res.error || !res.data) {
        console.error(
          `[vaults] failed to count secrets for ${v.id}`,
          res.error,
        );
        return 0;
      }
      return res.data.secrets.length;
    }),
  );

  const vaults: Vault[] = owned.map((v, i) => ({
    id: v.id,
    name: v.name,
    description: v.description ?? "",
    keyCount: counts[i],
  }));

  return Response.json({ vaults });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { name, description } = body as Record<string, unknown>;

  if (typeof name !== "string" || typeof description !== "string") {
    return Response.json(
      { error: "`name` and `description` must be strings" },
      { status: 400 },
    );
  }

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  if (trimmedName.length === 0 || trimmedName.length > NAME_MAX) {
    return Response.json(
      { error: `\`name\` must be 1–${NAME_MAX} characters` },
      { status: 400 },
    );
  }

  if (trimmedDescription.length > DESCRIPTION_MAX) {
    return Response.json(
      { error: `\`description\` must be ≤ ${DESCRIPTION_MAX} characters` },
      { status: 400 },
    );
  }

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

  const { data, error } = await client.vault.create({
    name: trimmedName,
    description: trimmedDescription,
  });

  if (error || !data) {
    console.error("[vaults] 1claw create failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to create vault upstream" },
      { status: 502 },
    );
  }

  try {
    await claimVault(data.id, session.user.id);
  } catch (claimErr) {
    console.error(
      "[vaults] ownership claim failed; rolling back upstream vault",
      claimErr,
    );
    const { error: rollbackError } = await client.vault.delete(data.id);
    if (rollbackError) {
      console.error(
        `[vaults] rollback delete failed for orphan vault ${data.id}`,
        rollbackError,
      );
    }
    return Response.json(
      { error: "Failed to register vault ownership" },
      { status: 500 },
    );
  }

  const vault: Vault = {
    id: data.id,
    name: data.name,
    description: data.description ?? "",
    keyCount: 0,
  };

  return Response.json({ vault }, { status: 201 });
}
