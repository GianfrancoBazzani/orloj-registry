import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { siwe } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import {
  createPublicClient,
  http,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { normalize } from "viem/ens";
import { parseSiweMessage } from "viem/siwe";
import { resolveEnsChain } from "./chains";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const siweDomain = new URL(baseURL).host;

const ENS_TIMEOUT_MS = 3000;
const { chain: ensChain, rpcUrl: ensRpcUrl, key: ensChainKey } =
  resolveEnsChain();
console.log(`[auth] ENS lookups via ${ensChainKey} (${ensRpcUrl})`);
const ensClient = createPublicClient({
  chain: ensChain,
  transport: http(ensRpcUrl, { timeout: ENS_TIMEOUT_MS }),
});

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  }),
  plugins: [
    siwe({
      domain: siweDomain,
      anonymous: true,
      getNonce: async () => randomBytes(16).toString("hex"),
      verifyMessage: async ({ message, signature, address, cacao }) => {
        const fields = parseSiweMessage(message);

        if (!fields.nonce || fields.nonce !== cacao?.p.nonce) return false;
        if (!fields.domain || fields.domain !== cacao.p.domain) return false;
        if (
          !fields.address ||
          fields.address.toLowerCase() !== address.toLowerCase()
        )
          return false;
        const now = Date.now();
        if (
          fields.expirationTime &&
          now > new Date(fields.expirationTime).getTime()
        )
          return false;
        if (fields.notBefore && now < new Date(fields.notBefore).getTime())
          return false;

        try {
          const recovered = await recoverMessageAddress({
            message,
            signature: signature as Hex,
          });
          return recovered.toLowerCase() === address.toLowerCase();
        } catch {
          return false;
        }
      },
      ensLookup: async ({ walletAddress }) => {
        try {
          const name = await withTimeout(
            ensClient.getEnsName({ address: walletAddress as Address }),
            ENS_TIMEOUT_MS,
          );
          if (!name) return { name: "", avatar: "" };
          const avatar = await withTimeout(
            ensClient.getEnsAvatar({ name: normalize(name) }),
            ENS_TIMEOUT_MS,
          );
          return { name, avatar: avatar ?? "" };
        } catch {
          return { name: "", avatar: "" };
        }
      },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
