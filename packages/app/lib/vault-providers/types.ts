import type { ProviderId } from "../vault-ownership";

export type { ProviderId };

export interface VaultMeta {
  id: string;
  name: string;
  description: string;
  address?: `0x${string}`;
  keyCount: number;
}

export interface SecretRecord {
  id: string;
  key: string;
  type?: string;
  version: number;
  createdAt: string;
}

export interface SecretWithValue extends SecretRecord {
  value: string;
}

export interface CreateVaultParams {
  name: string;
  description: string;
}

export interface SetSecretParams {
  key: string;
  value: string;
  type?: string;
}

export interface EthSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

export interface KeyGrant {
  id: string;
  vaultId: string;
  secretPathPattern: string;
  principalType: string;
  principalId: string;
  permissions: string[];
  conditions: Record<string, unknown>;
  expiresAt?: string;
  createdAt: string;
}

export interface CreateGrantParams {
  agentId: string;
  secretPathPattern: string;
  permissions: string[];
  conditions?: Record<string, unknown>;
  expiresAt?: string;
}

export interface UpdateGrantParams {
  permissions?: string[];
  conditions?: Record<string, unknown>;
  expiresAt?: string;
}

export interface VaultProvider {
  readonly id: ProviderId;

  createVault(params: CreateVaultParams): Promise<VaultMeta>;

  listVaults(vaultIds: string[]): Promise<VaultMeta[]>;

  getVault(vaultId: string): Promise<VaultMeta>;

  deleteVault(vaultId: string): Promise<void>;

  setSecret(vaultId: string, params: SetSecretParams): Promise<SecretRecord>;

  getSecret(vaultId: string, key: string): Promise<SecretWithValue>;

  listSecrets(vaultId: string): Promise<SecretRecord[]>;

  deleteSecret(vaultId: string, key: string): Promise<void>;

  signDigest(vaultId: string, digest: `0x${string}`): Promise<EthSignature>;

  listGrants(vaultId: string): Promise<KeyGrant[]>;

  createGrant(vaultId: string, params: CreateGrantParams): Promise<KeyGrant>;

  updateGrant(
    vaultId: string,
    grantId: string,
    params: UpdateGrantParams,
  ): Promise<KeyGrant>;

  revokeGrant(vaultId: string, grantId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 502,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderConfigError extends ProviderError {
  constructor(message: string) {
    super(message, 503);
    this.name = "ProviderConfigError";
  }
}
