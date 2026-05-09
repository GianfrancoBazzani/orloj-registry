// Orbitport KMS vault provider.
//
// Provisions one ETHEREUM (secp256k1) signing key + one TRANSIT
// (AES_256_GCM96) envelope-encryption key per vault. Vault metadata and
// secret ciphertexts live in our own Postgres (`orbitport_vault`,
// `orbitport_secret`); cleartext key material and the TRANSIT master key
// live in Orbitport's HSM-backed KMS.

import { randomUUID } from "crypto";
import { getPool } from "../db";
import {
  ProviderConfigError,
  ProviderError,
  type CreateGrantParams,
  type CreateVaultParams,
  type EthSignature,
  type KeyGrant,
  type SecretRecord,
  type SecretWithValue,
  type SetSecretParams,
  type UpdateGrantParams,
  type VaultMeta,
  type VaultProvider,
} from "./types";

interface OrbitportSdk {
  kms: {
    createKey(req: {
      alias: string;
      keySpec: string;
      keyUsage: string;
      scheme?: string;
      description?: string;
      tags?: { TagKey: string; TagValue: string }[];
    }): Promise<{
      data: {
        KeyMetadata: {
          KeyId: string;
          Address?: string;
          Alias: string;
          Scheme: string;
        };
      };
    }>;
    encrypt(req: {
      keyId: string;
      plaintext: string;
    }): Promise<{ data: { CiphertextBlob: string } }>;
    decrypt(req: {
      keyId: string;
      ciphertextBlob: string;
    }): Promise<{ data: { Plaintext: string } }>;
    sign(req: {
      keyId: string;
      message: Uint8Array;
      signingAlgorithm: string;
      messageType: string;
    }): Promise<{ data: { Signature: string } }>;
  };
}

let sdkPromise: Promise<OrbitportSdk> | null = null;

const getSdk = async (): Promise<OrbitportSdk> => {
  if (sdkPromise) return sdkPromise;

  const clientId = process.env.ORBITPORT_CLIENT_ID;
  const clientSecret = process.env.ORBITPORT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ProviderConfigError(
      "ORBITPORT_CLIENT_ID / ORBITPORT_CLIENT_SECRET are not set. Add them to .env.local to enable SpaceComputer-backed vaults.",
    );
  }

  sdkPromise = (async () => {
    // The SDK is loaded lazily so the app keeps building when it isn't
    // installed yet (it's only required at runtime once a user opts into the
    // SpaceComputer provider). The package name is held in a variable so the
    // TypeScript checker doesn't try to resolve it statically.
    const sdkPkg: string = "@spacecomputer-io/orbitport-sdk-ts";
    let mod: { OrbitportSDK: new (opts: unknown) => OrbitportSdk };
    try {
      mod = (await import(sdkPkg)) as {
        OrbitportSDK: new (opts: unknown) => OrbitportSdk;
      };
    } catch {
      throw new ProviderConfigError(
        "@spacecomputer-io/orbitport-sdk-ts is not installed. Run `pnpm --filter app add @spacecomputer-io/orbitport-sdk-ts` first.",
      );
    }
    return new mod.OrbitportSDK({
      config: { clientId, clientSecret },
    });
  })().catch((err) => {
    sdkPromise = null;
    throw err;
  });

  return sdkPromise;
};

const buildAlias = (vaultId: string, kind: "sign" | "transit") =>
  `orloj-vault-${vaultId}-${kind}`;

const isoNow = () => new Date().toISOString();

const toAddress = (raw: string | undefined): `0x${string}` => {
  if (!raw || !raw.startsWith("0x") || raw.length !== 42) {
    throw new ProviderError(
      "Orbitport returned no address for the ETHEREUM key",
      502,
    );
  }
  return raw.toLowerCase() as `0x${string}`;
};

// Orbitport's gateway returns signatures as hex strings (with or without `0x`
// prefix). We accept both, with a base64 fallback in case the wire format
// changes.
const decodeSignature = (raw: string): Buffer => {
  const hexBody =
    raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length === 130) {
    return Buffer.from(hexBody, "hex");
  }
  return Buffer.from(raw, "base64");
};

interface OrbitportVaultRow {
  vault_id: string;
  name: string;
  description: string;
  kms_signing_key_id: string;
  kms_transit_key_id: string;
  address: string;
  created_at: Date;
}

const loadVaultRow = async (vaultId: string): Promise<OrbitportVaultRow> => {
  const pool = await getPool();
  const { rows } = await pool.query<OrbitportVaultRow>(
    `SELECT vault_id, name, description, kms_signing_key_id, kms_transit_key_id, address, created_at
       FROM orbitport_vault WHERE vault_id = $1`,
    [vaultId],
  );
  if (rows.length === 0) {
    throw new ProviderError("Orbitport vault not found", 404);
  }
  return rows[0];
};

const countSecrets = async (vaultId: string): Promise<number> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM orbitport_secret WHERE vault_id = $1`,
    [vaultId],
  );
  return Number(rows[0]?.n ?? 0);
};

export class OrbitportVaultProvider implements VaultProvider {
  readonly id = "orbitport" as const;

  async createVault(params: CreateVaultParams): Promise<VaultMeta> {
    const sdk = await getSdk();
    const vaultId = randomUUID();

    let signingKeyId: string | null = null;
    let transitKeyId: string | null = null;

    try {
      const sharedTags = [
        { TagKey: "orloj.vault_id", TagValue: vaultId },
        { TagKey: "orloj.vault_name", TagValue: params.name },
      ];

      const signing = await sdk.kms.createKey({
        alias: buildAlias(vaultId, "sign"),
        keySpec: "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY",
        scheme: "ETHEREUM",
        description: `Orloj signing key — ${params.name}`,
        tags: [...sharedTags, { TagKey: "orloj.role", TagValue: "signing" }],
      });
      signingKeyId = signing.data.KeyMetadata.KeyId;
      const address = toAddress(signing.data.KeyMetadata.Address);

      const transit = await sdk.kms.createKey({
        alias: buildAlias(vaultId, "transit"),
        keySpec: "AES_256_GCM96",
        keyUsage: "ENCRYPT_DECRYPT",
        scheme: "TRANSIT",
        description: `Orloj envelope-encryption key — ${params.name}`,
        tags: [...sharedTags, { TagKey: "orloj.role", TagValue: "transit" }],
      });
      transitKeyId = transit.data.KeyMetadata.KeyId;

      const pool = await getPool();
      await pool.query(
        `INSERT INTO orbitport_vault
           (vault_id, name, description, kms_signing_key_id, kms_transit_key_id, address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          vaultId,
          params.name,
          params.description,
          signingKeyId,
          transitKeyId,
          address,
        ],
      );

      return {
        id: vaultId,
        name: params.name,
        description: params.description,
        address,
        keyCount: 0,
      };
    } catch (err) {
      // Best-effort cleanup of orphaned KMS keys. Orbitport KMS does not
      // expose key deletion in the SDK we use, so on failure we just
      // surface the error — the orphaned alias will need manual cleanup.
      console.error("[orbitport] createVault failed", {
        vaultId,
        signingKeyId,
        transitKeyId,
        err,
      });
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        err instanceof Error ? err.message : "Orbitport createVault failed",
      );
    }
  }

  async listVaults(vaultIds: string[]): Promise<VaultMeta[]> {
    if (vaultIds.length === 0) return [];
    const pool = await getPool();
    const { rows } = await pool.query<OrbitportVaultRow>(
      `SELECT vault_id, name, description, kms_signing_key_id, kms_transit_key_id, address, created_at
         FROM orbitport_vault WHERE vault_id = ANY($1::text[])`,
      [vaultIds],
    );
    const counts = await Promise.all(
      rows.map((r) => countSecrets(r.vault_id)),
    );
    return rows.map((r, i) => ({
      id: r.vault_id,
      name: r.name,
      description: r.description,
      address: toAddress(r.address),
      keyCount: counts[i],
    }));
  }

  async getVault(vaultId: string): Promise<VaultMeta> {
    const row = await loadVaultRow(vaultId);
    return {
      id: row.vault_id,
      name: row.name,
      description: row.description,
      address: toAddress(row.address),
      keyCount: await countSecrets(row.vault_id),
    };
  }

  async deleteVault(vaultId: string): Promise<void> {
    // No upstream key-delete is exposed by the SDK at this version, so we
    // only drop our own metadata + ciphertexts. The Orbitport keys remain
    // (orphaned, with a deterministic alias) — acceptable for a hackathon
    // build; document this in the README.
    const pool = await getPool();
    await pool.query(`DELETE FROM orbitport_vault WHERE vault_id = $1`, [
      vaultId,
    ]);
  }

  async setSecret(
    vaultId: string,
    params: SetSecretParams,
  ): Promise<SecretRecord> {
    const sdk = await getSdk();
    const row = await loadVaultRow(vaultId);

    const enc = await sdk.kms.encrypt({
      keyId: row.kms_transit_key_id,
      plaintext: params.value,
    });
    const ciphertext = enc.data.CiphertextBlob;

    const pool = await getPool();
    const { rows } = await pool.query<{
      key: string;
      type: string | null;
      version: number;
      created_at: Date;
    }>(
      `INSERT INTO orbitport_secret (vault_id, key, type, ciphertext, version)
         VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (vault_id, key) DO UPDATE
         SET type = EXCLUDED.type,
             ciphertext = EXCLUDED.ciphertext,
             version = orbitport_secret.version + 1,
             created_at = now()
       RETURNING key, type, version, created_at`,
      [vaultId, params.key, params.type ?? null, ciphertext],
    );

    const r = rows[0];
    return {
      id: `${vaultId}:${r.key}`,
      key: r.key,
      type: r.type ?? undefined,
      version: r.version,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : isoNow(),
    };
  }

  async getSecret(vaultId: string, key: string): Promise<SecretWithValue> {
    const sdk = await getSdk();
    const row = await loadVaultRow(vaultId);
    const pool = await getPool();
    const { rows } = await pool.query<{
      ciphertext: string;
      type: string | null;
      version: number;
      created_at: Date;
    }>(
      `SELECT ciphertext, type, version, created_at
         FROM orbitport_secret WHERE vault_id = $1 AND key = $2`,
      [vaultId, key],
    );
    if (rows.length === 0) {
      throw new ProviderError("Secret not found", 404);
    }
    const r = rows[0];
    const dec = await sdk.kms.decrypt({
      keyId: row.kms_transit_key_id,
      ciphertextBlob: r.ciphertext,
    });
    return {
      id: `${vaultId}:${key}`,
      key,
      type: r.type ?? undefined,
      version: r.version,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : isoNow(),
      value: dec.data.Plaintext,
    };
  }

  async listSecrets(vaultId: string): Promise<SecretRecord[]> {
    const pool = await getPool();
    const { rows } = await pool.query<{
      key: string;
      type: string | null;
      version: number;
      created_at: Date;
    }>(
      `SELECT key, type, version, created_at
         FROM orbitport_secret WHERE vault_id = $1 ORDER BY key ASC`,
      [vaultId],
    );
    return rows.map((r) => ({
      id: `${vaultId}:${r.key}`,
      key: r.key,
      type: r.type ?? undefined,
      version: r.version,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : isoNow(),
    }));
  }

  async deleteSecret(vaultId: string, key: string): Promise<void> {
    const pool = await getPool();
    await pool.query(
      `DELETE FROM orbitport_secret WHERE vault_id = $1 AND key = $2`,
      [vaultId, key],
    );
  }

  async signDigest(
    vaultId: string,
    digest: `0x${string}`,
  ): Promise<EthSignature> {
    const sdk = await getSdk();
    const row = await loadVaultRow(vaultId);

    if (!digest.startsWith("0x") || digest.length !== 66) {
      throw new ProviderError("Digest must be a 32-byte 0x-hex string", 400);
    }
    const messageBytes = Uint8Array.from(
      digest
        .slice(2)
        .match(/.{2}/g)!
        .map((h) => parseInt(h, 16)),
    );

    const res = await sdk.kms.sign({
      keyId: row.kms_signing_key_id,
      message: messageBytes,
      signingAlgorithm: "ETHEREUM_SECP256K1",
      messageType: "DIGEST",
    });

    const sig = decodeSignature(res.data.Signature);
    if (sig.length !== 65) {
      throw new ProviderError(
        `Unexpected signature length ${sig.length} (want 65). Raw = ${res.data.Signature.slice(0, 40)}…`,
        502,
      );
    }
    const r = `0x${sig.subarray(0, 32).toString("hex")}` as `0x${string}`;
    const s = `0x${sig.subarray(32, 64).toString("hex")}` as `0x${string}`;
    const vRaw = sig[64];
    const v = vRaw < 27 ? 27 + vRaw : vRaw;
    return { r, s, v };
  }

  async listGrants(vaultId: string): Promise<KeyGrant[]> {
    const pool = await getPool();
    const { rows } = await pool.query<OrbitportGrantRow>(
      `SELECT id, vault_id, agent_id, secret_path_pattern, permissions,
              conditions, expires_at, created_at
         FROM orbitport_grant WHERE vault_id = $1 ORDER BY created_at ASC`,
      [vaultId],
    );
    return rows.map(grantRowToKeyGrant);
  }

  async createGrant(
    vaultId: string,
    params: CreateGrantParams,
  ): Promise<KeyGrant> {
    // Verify the vault exists; we need it to error correctly when the caller
    // hits a non-existent / non-Orbitport id by mistake.
    await loadVaultRow(vaultId);

    const pool = await getPool();
    const grantId = randomUUID();
    const { rows } = await pool.query<OrbitportGrantRow>(
      `INSERT INTO orbitport_grant
         (id, vault_id, agent_id, secret_path_pattern, permissions, conditions, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING id, vault_id, agent_id, secret_path_pattern, permissions,
                 conditions, expires_at, created_at`,
      [
        grantId,
        vaultId,
        params.agentId,
        params.secretPathPattern,
        JSON.stringify(params.permissions),
        JSON.stringify(params.conditions ?? {}),
        params.expiresAt ?? null,
      ],
    );
    return grantRowToKeyGrant(rows[0]);
  }

  async updateGrant(
    vaultId: string,
    grantId: string,
    params: UpdateGrantParams,
  ): Promise<KeyGrant> {
    const sets: string[] = [];
    const values: unknown[] = [grantId, vaultId];
    if (params.permissions !== undefined) {
      values.push(JSON.stringify(params.permissions));
      sets.push(`permissions = $${values.length}::jsonb`);
    }
    if (params.conditions !== undefined) {
      values.push(JSON.stringify(params.conditions));
      sets.push(`conditions = $${values.length}::jsonb`);
    }
    if (params.expiresAt !== undefined) {
      values.push(params.expiresAt);
      sets.push(`expires_at = $${values.length}`);
    }

    if (sets.length === 0) {
      // Nothing to update — just return the current row.
      const pool = await getPool();
      const { rows } = await pool.query<OrbitportGrantRow>(
        `SELECT id, vault_id, agent_id, secret_path_pattern, permissions,
                conditions, expires_at, created_at
           FROM orbitport_grant WHERE id = $1 AND vault_id = $2`,
        [grantId, vaultId],
      );
      if (rows.length === 0) {
        throw new ProviderError("Grant not found", 404);
      }
      return grantRowToKeyGrant(rows[0]);
    }

    const pool = await getPool();
    const { rows } = await pool.query<OrbitportGrantRow>(
      `UPDATE orbitport_grant SET ${sets.join(", ")}
         WHERE id = $1 AND vault_id = $2
         RETURNING id, vault_id, agent_id, secret_path_pattern, permissions,
                   conditions, expires_at, created_at`,
      values,
    );
    if (rows.length === 0) {
      throw new ProviderError("Grant not found", 404);
    }
    return grantRowToKeyGrant(rows[0]);
  }

  async revokeGrant(vaultId: string, grantId: string): Promise<void> {
    const pool = await getPool();
    await pool.query(
      `DELETE FROM orbitport_grant WHERE id = $1 AND vault_id = $2`,
      [grantId, vaultId],
    );
  }
}

interface OrbitportGrantRow {
  id: string;
  vault_id: string;
  agent_id: string;
  secret_path_pattern: string;
  permissions: string[] | string;
  conditions: Record<string, unknown> | string;
  expires_at: Date | null;
  created_at: Date;
}

const parseJsonField = <T,>(value: T | string, fallback: T): T => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value ?? fallback;
};

const grantRowToKeyGrant = (row: OrbitportGrantRow): KeyGrant => ({
  id: row.id,
  vaultId: row.vault_id,
  secretPathPattern: row.secret_path_pattern,
  principalType: "agent",
  principalId: row.agent_id,
  permissions: parseJsonField<string[]>(row.permissions, []),
  conditions: parseJsonField<Record<string, unknown>>(row.conditions, {}),
  expiresAt:
    row.expires_at instanceof Date ? row.expires_at.toISOString() : undefined,
  createdAt:
    row.created_at instanceof Date ? row.created_at.toISOString() : isoNow(),
});
