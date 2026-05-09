import { Pool } from "pg";

let poolPromise: Promise<Pool> | null = null;

const ensureSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_ownership (
      vault_id   TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS vault_ownership_user_idx
      ON vault_ownership(user_id)
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
