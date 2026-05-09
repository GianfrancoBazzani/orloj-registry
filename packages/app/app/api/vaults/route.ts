import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
  type ProviderId,
} from "@/lib/vault-providers";
import { claimVault, listVaultsForUser } from "@/lib/vault-ownership";
import type { Vault } from "@/components/data";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

const isProviderId = (v: unknown): v is ProviderId =>
  v === "oneclaw" || v === "orbitport";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const owned = await listVaultsForUser(session.user.id);
  const byProvider = owned.reduce<Record<ProviderId, string[]>>(
    (acc, v) => {
      acc[v.provider].push(v.vaultId);
      return acc;
    },
    { oneclaw: [], orbitport: [] },
  );

  const results = await Promise.allSettled([
    byProvider.oneclaw.length > 0
      ? getProvider("oneclaw").listVaults(byProvider.oneclaw)
      : Promise.resolve([]),
    byProvider.orbitport.length > 0
      ? getProvider("orbitport").listVaults(byProvider.orbitport)
      : Promise.resolve([]),
  ]);

  const vaults: Vault[] = [];
  const errors: string[] = [];

  if (results[0].status === "fulfilled") {
    for (const v of results[0].value) {
      vaults.push({
        id: v.id,
        name: v.name,
        description: v.description,
        keyCount: v.keyCount,
        provider: "oneclaw",
        address: v.address,
      });
    }
  } else {
    console.error("[vaults] oneclaw listVaults failed", results[0].reason);
    errors.push("oneclaw");
  }

  if (results[1].status === "fulfilled") {
    for (const v of results[1].value) {
      vaults.push({
        id: v.id,
        name: v.name,
        description: v.description,
        keyCount: v.keyCount,
        provider: "orbitport",
        address: v.address,
      });
    }
  } else {
    console.error("[vaults] orbitport listVaults failed", results[1].reason);
    errors.push("orbitport");
  }

  return Response.json({ vaults, errors });
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

  const { name, description, provider } = body as Record<string, unknown>;

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

  const providerId: ProviderId =
    provider === undefined ? "oneclaw" : isProviderId(provider) ? provider : "oneclaw";
  if (provider !== undefined && !isProviderId(provider)) {
    return Response.json(
      { error: "`provider` must be 'oneclaw' or 'orbitport'" },
      { status: 400 },
    );
  }

  let created;
  try {
    created = await getProvider(providerId).createVault({
      name: trimmedName,
      description: trimmedDescription,
    });
  } catch (err) {
    return providerErrorToResponse(err);
  }

  try {
    await claimVault(created.id, session.user.id, providerId);
  } catch (claimErr) {
    console.error(
      "[vaults] ownership claim failed; rolling back upstream vault",
      claimErr,
    );
    try {
      await getProvider(providerId).deleteVault(created.id);
    } catch (rollbackErr) {
      console.error(
        `[vaults] rollback delete failed for orphan vault ${created.id}`,
        rollbackErr,
      );
    }
    return Response.json(
      { error: "Failed to register vault ownership" },
      { status: 500 },
    );
  }

  const vault: Vault = {
    id: created.id,
    name: created.name,
    description: created.description,
    keyCount: created.keyCount,
    provider: providerId,
    address: created.address,
  };

  return Response.json({ vault }, { status: 201 });
}
