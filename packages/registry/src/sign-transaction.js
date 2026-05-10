import { resolveVaultForAgent } from "./vault-resolve.js";
import { signWithOrbitport } from "./vault-providers/orbitport.js";
import { signWithOneclaw } from "./vault-providers/oneclaw.js";

// Resolve the calling agent's vault provider and sign accordingly.
// Returns a 0x-prefixed RLP-encoded signed tx ready for sendRawTransaction.
export async function signTransaction({
  agentId,
  chain,
  publicClient,
  to,
  value = 0n,
  data = "0x",
  nonce,
}) {
  const v = await resolveVaultForAgent(agentId);

  if (v.provider === "orbitport") {
    return signWithOrbitport({
      kmsSigningKeyId: v.kmsSigningKeyId,
      address: v.address,
      chain,
      publicClient,
      to,
      value,
      data,
      nonce,
    });
  }

  return signWithOneclaw({
    vaultId: v.vaultId,
    signingKeyPath: v.signingKeyPath,
    chain,
    publicClient,
    to,
    value,
    data,
    nonce,
  });
}
