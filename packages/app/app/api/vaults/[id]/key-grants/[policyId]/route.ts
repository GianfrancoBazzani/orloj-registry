import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOneclawClient } from "@/lib/oneclaw";
import { assertVaultOwner } from "@/lib/vault-ownership";

const PERMISSION_MAX = 32;
const VALID_PERMISSIONS = new Set(["read", "write", "sign", "admin"]);

const initClient = async () => {
  try {
    return { client: await getOneclawClient() } as const;
  } catch (err) {
    console.error("[key-grants] 1claw client init failed", err);
    return {
      response: Response.json(
        { error: "Vault service is not configured" },
        { status: 503 },
      ),
    } as const;
  }
};

const serializeGrant = (p: {
  id: string;
  vault_id: string;
  secret_path_pattern: string;
  principal_type: string;
  principal_id: string;
  permissions: string[];
  conditions: Record<string, unknown>;
  expires_at?: string;
  created_at: string;
}) => ({
  id: p.id,
  vaultId: p.vault_id,
  secretPathPattern: p.secret_path_pattern,
  principalType: p.principal_type,
  principalId: p.principal_id,
  permissions: p.permissions,
  conditions: p.conditions,
  expiresAt: p.expires_at,
  createdAt: p.created_at,
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; policyId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, policyId } = await params;
  if (!id || !policyId) {
    return Response.json(
      { error: "Missing vault id or grant id" },
      { status: 400 },
    );
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

  const { permissions, conditions, expiresAt } = body as Record<string, unknown>;

  const update: {
    permissions?: string[];
    conditions?: Record<string, unknown>;
    expires_at?: string;
  } = {};

  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return Response.json(
        { error: "`permissions` must be a non-empty array of strings" },
        { status: 400 },
      );
    }
    for (const p of permissions) {
      if (typeof p !== "string" || p.length === 0 || p.length > PERMISSION_MAX) {
        return Response.json(
          { error: "`permissions` entries must be non-empty strings" },
          { status: 400 },
        );
      }
      if (!VALID_PERMISSIONS.has(p)) {
        return Response.json(
          {
            error: `Unknown permission \`${p}\`. Allowed: ${[...VALID_PERMISSIONS].join(", ")}`,
          },
          { status: 400 },
        );
      }
    }
    update.permissions = permissions as string[];
  }

  if (conditions !== undefined) {
    if (
      typeof conditions !== "object" ||
      conditions === null ||
      Array.isArray(conditions)
    ) {
      return Response.json(
        { error: "`conditions` must be an object when provided" },
        { status: 400 },
      );
    }
    update.conditions = conditions as Record<string, unknown>;
  }

  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
      return Response.json(
        { error: "`expiresAt` must be an ISO-8601 date string" },
        { status: 400 },
      );
    }
    update.expires_at = expiresAt;
  }

  if (Object.keys(update).length === 0) {
    return Response.json(
      {
        error:
          "Provide at least one of `permissions`, `conditions`, `expiresAt`",
      },
      { status: 400 },
    );
  }

  const init = await initClient();
  if ("response" in init) return init.response;

  const { data, error } = await init.client.access.update(id, policyId, update);
  if (error || !data) {
    console.error("[key-grants] 1claw update failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to update key grant upstream" },
      { status: 502 },
    );
  }

  return Response.json({ grant: serializeGrant(data) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; policyId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, policyId } = await params;
  if (!id || !policyId) {
    return Response.json(
      { error: "Missing vault id or grant id" },
      { status: 400 },
    );
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership !== true) return ownership;

  const init = await initClient();
  if ("response" in init) return init.response;

  const { error } = await init.client.access.revoke(id, policyId);
  if (error) {
    console.error("[key-grants] 1claw revoke failed", error);
    return Response.json(
      { error: error.message ?? "Failed to revoke key grant upstream" },
      { status: 502 },
    );
  }

  return new Response(null, { status: 204 });
}
