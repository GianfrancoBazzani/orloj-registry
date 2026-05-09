import { Pool } from "pg";

let poolPromise: Promise<Pool> | null = null;

const ensureSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_ownership (
      vault_id   TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider   TEXT NOT NULL DEFAULT 'oneclaw',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    ALTER TABLE vault_ownership
      ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'oneclaw'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS vault_ownership_user_idx
      ON vault_ownership(user_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbitport_vault (
      vault_id           TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      kms_signing_key_id TEXT NOT NULL,
      kms_transit_key_id TEXT NOT NULL,
      address            TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // The orbitport_vault row is inserted before vault_ownership during create,
  // so a FK on vault_id breaks the create flow. Integrity is maintained at the
  // app layer (provider.deleteVault drops the metadata before releaseVault
  // drops ownership). Drop the FK if a previous schema version added it.
  await pool.query(`
    ALTER TABLE orbitport_vault
      DROP CONSTRAINT IF EXISTS orbitport_vault_vault_id_fkey
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbitport_secret (
      vault_id   TEXT NOT NULL REFERENCES orbitport_vault(vault_id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      type       TEXT,
      ciphertext TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (vault_id, key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS orbitport_secret_vault_idx
      ON orbitport_secret(vault_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbitport_grant (
      id                  TEXT PRIMARY KEY,
      vault_id            TEXT NOT NULL REFERENCES orbitport_vault(vault_id) ON DELETE CASCADE,
      agent_id            TEXT NOT NULL,
      secret_path_pattern TEXT NOT NULL,
      permissions         JSONB NOT NULL DEFAULT '[]'::jsonb,
      conditions          JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS orbitport_grant_vault_idx
      ON orbitport_grant(vault_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS orbitport_grant_agent_idx
      ON orbitport_grant(agent_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_ownership (
      agent_id   TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS agent_ownership_user_idx
      ON agent_ownership(user_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_api_key (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agent_ownership(agent_id) ON DELETE CASCADE,
      token        TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at   TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mcp_api_key_token_idx
      ON mcp_api_key(token)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mcp_api_key_agent_id_idx
      ON mcp_api_key(agent_id)
  `);
};

export const getPool = (): Promise<Pool> => {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await ensureSchema(pool);
    return pool;
  })().catch((err) => {
    poolPromise = null;
    throw err;
  });
  return poolPromise;
};
