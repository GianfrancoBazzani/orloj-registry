import { getOneclawClient } from "../oneclaw";
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

interface OneclawPolicyShape {
  id: string;
  vault_id: string;
  secret_path_pattern: string;
  principal_type: string;
  principal_id: string;
  permissions: string[];
  conditions: Record<string, unknown>;
  expires_at?: string;
  created_at: string;
}

const toGrant = (p: OneclawPolicyShape): KeyGrant => ({
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

const getClient = async () => {
  try {
    return await getOneclawClient();
  } catch (err) {
    throw new ProviderConfigError(
      err instanceof Error ? err.message : "1claw client init failed",
    );
  }
};

const toSecretRecord = (s: {
  id: string;
  path: string;
  type?: string;
  version: number;
  created_at: string;
}): SecretRecord => ({
  id: s.id,
  key: s.path,
  type: s.type,
  version: s.version,
  createdAt: s.created_at,
});

export class OneclawVaultProvider implements VaultProvider {
  readonly id = "oneclaw" as const;

  async createVault(params: CreateVaultParams): Promise<VaultMeta> {
    const client = await getClient();
    const { data, error } = await client.vault.create({
      name: params.name,
      description: params.description,
    });
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to create vault upstream");
    }
    return {
      id: data.id,
      name: data.name,
      description: data.description ?? "",
      keyCount: 0,
    };
  }

  async listVaults(vaultIds: string[]): Promise<VaultMeta[]> {
    if (vaultIds.length === 0) return [];
    const client = await getClient();
    const { data, error } = await client.vault.list();
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to list vaults upstream");
    }
    const wanted = new Set(vaultIds);
    const owned = data.vaults.filter((v) => wanted.has(v.id));
    const counts = await Promise.all(
      owned.map(async (v) => {
        const res = await client.secrets.list(v.id);
        if (res.error || !res.data) return 0;
        return res.data.secrets.length;
      }),
    );
    return owned.map((v, i) => ({
      id: v.id,
      name: v.name,
      description: v.description ?? "",
      keyCount: counts[i],
    }));
  }

  async getVault(vaultId: string): Promise<VaultMeta> {
    const client = await getClient();
    const { data, error } = await client.vault.get(vaultId);
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to get vault upstream");
    }
    const secretsRes = await client.secrets.list(vaultId);
    return {
      id: data.id,
      name: data.name,
      description: data.description ?? "",
      keyCount: secretsRes.data?.secrets.length ?? 0,
    };
  }

  async deleteVault(vaultId: string): Promise<void> {
    const client = await getClient();
    const { error } = await client.vault.delete(vaultId);
    if (error) {
      throw new ProviderError(error.message ?? "Failed to delete vault upstream");
    }
  }

  async setSecret(
    vaultId: string,
    params: SetSecretParams,
  ): Promise<SecretRecord> {
    const client = await getClient();
    const { data, error } = await client.secrets.set(
      vaultId,
      params.key,
      params.value,
      params.type ? { type: params.type } : undefined,
    );
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to set secret upstream");
    }
    return toSecretRecord(data);
  }

  async getSecret(vaultId: string, key: string): Promise<SecretWithValue> {
    const client = await getClient();
    const { data, error } = await client.secrets.get(vaultId, key);
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to read secret upstream");
    }
    return { ...toSecretRecord(data), value: data.value };
  }

  async listSecrets(vaultId: string): Promise<SecretRecord[]> {
    const client = await getClient();
    const { data, error } = await client.secrets.list(vaultId);
    if (error || !data) {
      throw new ProviderError(error?.message ?? "Failed to list secrets upstream");
    }
    return data.secrets.map(toSecretRecord);
  }

  async deleteSecret(vaultId: string, key: string): Promise<void> {
    const client = await getClient();
    const { error } = await client.secrets.delete(vaultId, key);
    if (error) {
      throw new ProviderError(error.message ?? "Failed to delete secret upstream");
    }
  }

  async signDigest(_vaultId: string, _digest: `0x${string}`): Promise<EthSignature> {
    // 1Claw signing through this abstraction is not wired in this iteration.
    // Tx signing for 1Claw vaults goes through client.agents.signTransaction,
    // which expects an unsigned-tx shape rather than a raw digest. We'll
    // implement a 1Claw-specific signTx path when the agent flow lands.
    throw new ProviderError(
      "1Claw raw-digest signing is not implemented in this iteration",
      501,
    );
  }

  async listGrants(vaultId: string): Promise<KeyGrant[]> {
    const client = await getClient();
    const { data, error } = await client.access.listGrants(vaultId);
    if (error || !data) {
      throw new ProviderError(
        error?.message ?? "Failed to list key grants upstream",
      );
    }
    return data.policies.map((p) => toGrant(p as OneclawPolicyShape));
  }

  async createGrant(
    vaultId: string,
    params: CreateGrantParams,
  ): Promise<KeyGrant> {
    const client = await getClient();
    const { data, error } = await client.access.grantAgent(
      vaultId,
      params.agentId,
      params.permissions,
      {
        secretPathPattern: params.secretPathPattern,
        ...(params.conditions ? { conditions: params.conditions } : {}),
        ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
      },
    );
    if (error || !data) {
      throw new ProviderError(
        error?.message ?? "Failed to create key grant upstream",
      );
    }
    return toGrant(data as OneclawPolicyShape);
  }

  async updateGrant(
    vaultId: string,
    grantId: string,
    params: UpdateGrantParams,
  ): Promise<KeyGrant> {
    const client = await getClient();
    const update: {
      permissions?: string[];
      conditions?: Record<string, unknown>;
      expires_at?: string;
    } = {};
    if (params.permissions !== undefined) update.permissions = params.permissions;
    if (params.conditions !== undefined) update.conditions = params.conditions;
    if (params.expiresAt !== undefined) update.expires_at = params.expiresAt;

    const { data, error } = await client.access.update(vaultId, grantId, update);
    if (error || !data) {
      throw new ProviderError(
        error?.message ?? "Failed to update key grant upstream",
      );
    }
    return toGrant(data as OneclawPolicyShape);
  }

  async revokeGrant(vaultId: string, grantId: string): Promise<void> {
    const client = await getClient();
    const { error } = await client.access.revoke(vaultId, grantId);
    if (error) {
      throw new ProviderError(
        error.message ?? "Failed to revoke key grant upstream",
      );
    }
  }
}
