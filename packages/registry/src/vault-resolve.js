import { getPool } from "./db.mjs";
import { getOneclawClient } from "./vault-providers/oneclaw.js";

// Process-scoped cache. orloj_agent_id → { provider, ... }.
// Invalidate via clearVaultCache(agentId) on auth errors from upstream.
const cache = new Map();

export function clearVaultCache(agentId) {
  if (agentId) cache.delete(agentId);
  else cache.clear();
}

// Returns one of:
//   { provider: "orbitport", vaultId, kmsSigningKeyId, address }
//   { provider: "oneclaw",   oneclawAgentId, vaultId }
export async function resolveVaultForAgent(orlojAgentId) {
  if (!orlojAgentId) {
    throw new Error("resolveVaultForAgent requires an agentId");
  }
  const cached = cache.get(orlojAgentId);
  if (cached) return cached;

  const pool = getPool();

  // 1. Orbitport branch — does this agent have a live grant on an Orbitport vault?
  const orbitportRows = await pool.query(
    `SELECT v.vault_id, v.kms_signing_key_id, v.address
       FROM orbitport_grant g
       JOIN orbitport_vault v ON v.vault_id = g.vault_id
      WHERE g.agent_id = $1
        AND (g.expires_at IS NULL OR g.expires_at > now())
      ORDER BY g.created_at ASC
      LIMIT 1`,
    [orlojAgentId],
  );
  if (orbitportRows.rows.length > 0) {
    const r = orbitportRows.rows[0];
    const resolved = {
      provider: "orbitport",
      vaultId: r.vault_id,
      kmsSigningKeyId: r.kms_signing_key_id,
      address: r.address,
    };
    cache.set(orlojAgentId, resolved);
    return resolved;
  }

  // 2. 1Claw branch — orloj agent → user → user's 1Claw vault → upstream 1Claw agent.
  const ownerRows = await pool.query(
    `SELECT user_id FROM agent_ownership WHERE agent_id = $1`,
    [orlojAgentId],
  );
  if (ownerRows.rows.length === 0) {
    throw new Error(`No agent_ownership row for agent_id=${orlojAgentId}`);
  }
  const userId = ownerRows.rows[0].user_id;

  const vaultRows = await pool.query(
    `SELECT vault_id FROM vault_ownership
      WHERE user_id = $1 AND provider = 'oneclaw'
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId],
  );
  if (vaultRows.rows.length === 0) {
    throw new Error(
      `Agent ${orlojAgentId} has no Orbitport grant and the owning user has no 1Claw vault`,
    );
  }
  const vaultId = vaultRows.rows[0].vault_id;

  const client = await getOneclawClient();
  const { data, error } = await client.access.listGrants(vaultId);
  if (error || !data) {
    throw new Error(
      `1Claw listGrants failed for vault ${vaultId}: ${error?.message ?? error?.type ?? "unknown"}`,
    );
  }
  const agentGrant = data.policies.find((p) => p.principal_type === "agent");
  if (!agentGrant) {
    throw new Error(
      `1Claw vault ${vaultId} has no agent grant — cannot resolve a signing principal`,
    );
  }

  const resolved = {
    provider: "oneclaw",
    oneclawAgentId: agentGrant.principal_id,
    vaultId,
  };
  cache.set(orlojAgentId, resolved);
  return resolved;
}
