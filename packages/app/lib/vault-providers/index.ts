import { assertVaultOwner } from "../vault-ownership";
import { OneclawVaultProvider } from "./oneclaw";
import { OrbitportVaultProvider } from "./orbitport";
import {
  ProviderConfigError,
  ProviderError,
  type ProviderId,
  type VaultProvider,
} from "./types";

export type { ProviderId, VaultProvider };
export { ProviderError, ProviderConfigError };

let oneclaw: OneclawVaultProvider | null = null;
let orbitport: OrbitportVaultProvider | null = null;

export const getProvider = (id: ProviderId): VaultProvider => {
  switch (id) {
    case "oneclaw":
      if (!oneclaw) oneclaw = new OneclawVaultProvider();
      return oneclaw;
    case "orbitport":
      if (!orbitport) orbitport = new OrbitportVaultProvider();
      return orbitport;
  }
};

// Convenience: resolve ownership AND return the right provider in one step.
export const resolveVaultProvider = async (
  vaultId: string,
  userId: string,
): Promise<{ provider: VaultProvider } | Response> => {
  const ownership = await assertVaultOwner(vaultId, userId);
  if (ownership instanceof Response) return ownership;
  return { provider: getProvider(ownership.provider) };
};

export const providerErrorToResponse = (err: unknown): Response => {
  if (err instanceof ProviderConfigError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ProviderError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("[vault-providers] unhandled error", err);
  return Response.json({ error: "Internal error" }, { status: 500 });
};
