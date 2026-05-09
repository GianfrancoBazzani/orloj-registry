import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
} from "@/lib/vault-providers";
import { assertVaultOwner } from "@/lib/vault-ownership";
import { assertAgentOwner } from "@/lib/agent-ownership";

const SECRET_PATH_MAX = 256;
const PERMISSION_MAX = 32;
const VALID_PERMISSIONS = new Set(["read", "write", "sign", "admin"]);

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
    const grants = await getProvider(ownership.provider).listGrants(id);
    return Response.json({ grants });
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

  const vaultOwnership = await assertVaultOwner(id, session.user.id);
  if (vaultOwnership instanceof Response) return vaultOwnership;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { agentId, secretPathPattern, permissions, conditions, expiresAt } =
    body as Record<string, unknown>;

  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return Response.json(
      { error: "`agentId` must be a non-empty string" },
      { status: 400 },
    );
  }

  if (
    typeof secretPathPattern !== "string" ||
    secretPathPattern.trim().length === 0
  ) {
    return Response.json(
      { error: "`secretPathPattern` must be a non-empty string" },
      { status: 400 },
    );
  }

  const trimmedPattern = secretPathPattern.trim();
  if (trimmedPattern.length > SECRET_PATH_MAX) {
    return Response.json(
      { error: `\`secretPathPattern\` must be ≤ ${SECRET_PATH_MAX} characters` },
      { status: 400 },
    );
  }

  let normalizedPermissions: string[] = ["read"];
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
    normalizedPermissions = permissions as string[];
  }

  if (
    conditions !== undefined &&
    (typeof conditions !== "object" ||
      conditions === null ||
      Array.isArray(conditions))
  ) {
    return Response.json(
      { error: "`conditions` must be an object when provided" },
      { status: 400 },
    );
  }

  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
      return Response.json(
        { error: "`expiresAt` must be an ISO-8601 date string" },
        { status: 400 },
      );
    }
  }

  const agentOwnership = await assertAgentOwner(agentId, session.user.id);
  if (agentOwnership !== true) return agentOwnership;

  try {
    const grant = await getProvider(vaultOwnership.provider).createGrant(id, {
      agentId,
      secretPathPattern: trimmedPattern,
      permissions: normalizedPermissions,
      ...(conditions ? { conditions: conditions as Record<string, unknown> } : {}),
      ...(expiresAt ? { expiresAt: expiresAt as string } : {}),
    });
    return Response.json({ grant }, { status: 201 });
  } catch (err) {
    return providerErrorToResponse(err);
  }
}
