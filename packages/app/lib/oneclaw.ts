import { createClient, type OneclawClient } from "@1claw/sdk";

const ONECLAW_BASE_URL = "https://api.1claw.xyz";

let clientPromise: Promise<OneclawClient> | null = null;

export const getOneclawClient = async (): Promise<OneclawClient> => {
  if (clientPromise) return clientPromise;

  const apiKey = process.env["1CLAW_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "1CLAW_API_KEY is not set. Add it to .env.local to enable vault operations.",
    );
  }

  clientPromise = (async () => {
    const c = createClient({ baseUrl: ONECLAW_BASE_URL, apiKey });
    if (!apiKey.startsWith("ocv_")) {
      const { error } = await c.auth.apiKeyToken({ api_key: apiKey });
      if (error) {
        throw new Error(
          `1claw token exchange failed: ${error.message ?? error.type}`,
        );
      }
    }
    return c;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });

  return clientPromise;
};
