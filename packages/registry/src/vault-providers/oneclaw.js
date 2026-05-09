import { createClient } from "@1claw/sdk";
import { oneclawChainName } from "../chains.js";

const ONECLAW_BASE_URL = "https://api.1claw.xyz";

let clientPromise = null;

export async function getOneclawClient() {
  if (clientPromise) return clientPromise;

  const apiKey = process.env.ONECLAW_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ONECLAW_API_KEY is not set. Add it to .env to enable 1Claw signing.",
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

// Sign and return a fully-formed RLP-encoded broadcastable tx hex.
// 1Claw fills in nonce/gas/fees server-side when omitted.
export async function signWithOneclaw({
  oneclawAgentId,
  chain,
  to,
  value = 0n,
  data,
  nonce,
}) {
  const client = await getOneclawClient();
  const payload = {
    chain: oneclawChainName(chain.id),
    to,
    value: String(value ?? 0n),
    signing_key_path: "address",
    ...(data && data !== "0x" ? { data } : {}),
    ...(nonce !== undefined ? { nonce: Number(nonce) } : {}),
  };
  const { data: res, error } = await client.agents.signTransaction(
    oneclawAgentId,
    payload,
  );
  if (error) {
    throw new Error(
      `1Claw signTransaction failed: ${error.message ?? error.type}`,
    );
  }
  return res.signed_tx;
}
