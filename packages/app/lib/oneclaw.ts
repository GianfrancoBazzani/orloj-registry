import { createClient, type OneclawClient } from "@1claw/sdk";

const ONECLAW_BASE_URL = "https://api.1claw.xyz";

let client: OneclawClient | null = null;

export const getOneclawClient = (): OneclawClient => {
  if (client) return client;

  const apiKey = process.env["1CLAW_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "1CLAW_API_KEY is not set. Add it to .env.local to enable vault operations.",
    );
  }

  client = createClient({
    baseUrl: ONECLAW_BASE_URL,
    apiKey,
  });

  return client;
};
