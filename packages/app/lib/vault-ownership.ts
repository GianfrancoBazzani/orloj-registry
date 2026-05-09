import { getPool } from "./db";

export type ProviderId = "oneclaw" | "orbitport";

const isProvider = (v: unknown): v is ProviderId =>
  v === "oneclaw" || v === "orbitport";

export const listVaultsForUser = async (
  userId: string,
): Promise<{ vaultId: string; provider: ProviderId }[]> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ vault_id: string; provider: string }>(
    `SELECT vault_id, provider FROM vault_ownership WHERE user_id = $1`,
    [userId],
  );
  return rows
    .filter((r) => isProvider(r.provider))
    .map((r) => ({ vaultId: r.vault_id, provider: r.provider as ProviderId }));
};

export const claimVault = async (
  vaultId: string,
  userId: string,
  provider: ProviderId,
): Promise<void> => {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO vault_ownership (vault_id, user_id, provider) VALUES ($1, $2, $3)`,
    [vaultId, userId, provider],
  );
};

export const releaseVault = async (vaultId: string): Promise<void> => {
  const pool = await getPool();
  await pool.query(`DELETE FROM vault_ownership WHERE vault_id = $1`, [
    vaultId,
  ]);
};

// Returns `{ provider }` when the user owns the vault, otherwise a 404 Response
// so non-owners can't probe whether a vault id exists.
export const assertVaultOwner = async (
  vaultId: string,
  userId: string,
): Promise<{ provider: ProviderId } | Response> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ user_id: string; provider: string }>(
    `SELECT user_id, provider FROM vault_ownership WHERE vault_id = $1`,
    [vaultId],
  );
  if (
    rows.length === 0 ||
    rows[0].user_id !== userId ||
    !isProvider(rows[0].provider)
  ) {
    return Response.json({ error: "Vault not found" }, { status: 404 });
  }
  return { provider: rows[0].provider as ProviderId };
};
