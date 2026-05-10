import { createClient } from "@1claw/sdk";
import { privateKeyToAccount } from "viem/accounts";

const ONECLAW_BASE_URL = "https://api.1claw.xyz";

let clientPromise = null;

export async function getOneclawClient() {
  if (clientPromise) return clientPromise;

  const apiKey = process.env["1CLAW_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "1CLAW_API_KEY is not set. Add it to .env.local to enable 1Claw signing.",
    );
  }

  clientPromise = (async () => {
    const c = createClient({ baseUrl: ONECLAW_BASE_URL, apiKey });
    if (!apiKey.startsWith("ocv_")) {
      const { error } = await c.auth.apiKeyToken({ api_key: apiKey });
      if (error) {
        throw new Error(
          `1Claw token exchange failed: ${error.message ?? error.type}`,
        );
      }
    }
    return c;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });

  return clientPromise;
}

// Read the private key from the 1Claw vault and sign the tx locally.
// The registry's 1Claw API key (1ck_/ocv_) must have read permission on
// the secret path. Returns a 0x-prefixed RLP-encoded signed tx.
export async function signWithOneclaw({
  vaultId,
  signingKeyPath,
  chain,
  publicClient,
  to,
  value = 0n,
  data = "0x",
  nonce,
}) {
  const client = await getOneclawClient();
  const { data: secret, error } = await client.secrets.get(
    vaultId,
    signingKeyPath,
  );
  if (error || !secret) {
    throw new Error(
      `1Claw secrets.get failed for ${vaultId}/${signingKeyPath}: ${
        error?.message ?? error?.type ?? "unknown"
      }`,
    );
  }
  if (secret.type !== "private_key") {
    throw new Error(
      `1Claw secret at ${signingKeyPath} is not a private_key (type=${secret.type})`,
    );
  }

  const privateKey = secret.value.startsWith("0x")
    ? secret.value
    : `0x${secret.value}`;
  const account = privateKeyToAccount(privateKey);

  const [resolvedNonce, fees, gas] = await Promise.all([
    nonce !== undefined
      ? Promise.resolve(BigInt(nonce))
      : publicClient
          .getTransactionCount({ address: account.address, blockTag: "pending" })
          .then(BigInt),
    publicClient.estimateFeesPerGas(),
    publicClient.estimateGas({ account: account.address, to, value, data }),
  ]);

  return account.signTransaction({
    type: "eip1559",
    chainId: chain.id,
    nonce: Number(resolvedNonce),
    to,
    value,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}
