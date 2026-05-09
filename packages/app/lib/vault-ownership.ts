import { getPool } from "./db";

export const listVaultIdsForUser = async (
  userId: string,
): Promise<Set<string>> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ vault_id: string }>(
    `SELECT vault_id FROM vault_ownership WHERE user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.vault_id));
};

export const claimVault = async (
  vaultId: string,
  userId: string,
): Promise<void> => {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO vault_ownership (vault_id, user_id) VALUES ($1, $2)`,
    [vaultId, userId],
  );
};

export const releaseVault = async (vaultId: string): Promise<void> => {
  const pool = await getPool();
  await pool.query(`DELETE FROM vault_ownership WHERE vault_id = $1`, [
    vaultId,
  ]);
};

// Returns `true` when the user owns the vault, otherwise a 404 Response so
// non-owners can't probe whether a vault id exists.
export const assertVaultOwner = async (
  vaultId: string,
  userId: string,
): Promise<true | Response> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM vault_ownership WHERE vault_id = $1`,
    [vaultId],
  );
  if (rows.length === 0 || rows[0].user_id !== userId) {
    return Response.json({ error: "Vault not found" }, { status: 404 });
  }
  return true;
};
