import { headers } from "next/headers";
import { sepolia } from "viem/chains";
import { auth } from "@/lib/auth";
import {
  getProvider,
  providerErrorToResponse,
} from "@/lib/vault-providers";
import { assertVaultOwner } from "@/lib/vault-ownership";
import { signAndSend } from "@/lib/sign-tx";

const isHexAddress = (v: unknown): v is `0x${string}` =>
  typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);

const isHex = (v: unknown): v is `0x${string}` =>
  typeof v === "string" && /^0x([a-fA-F0-9]{2})*$/.test(v);

const parseBigint = (v: unknown, name: string): bigint => {
  if (v === undefined || v === null || v === "") return BigInt(0);
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      throw new Error(`\`${name}\` must be a valid integer string`);
    }
  }
  throw new Error(`\`${name}\` must be a number or numeric string`);
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "Missing vault id" }, { status: 400 });
  }

  const ownership = await assertVaultOwner(id, session.user.id);
  if (ownership instanceof Response) return ownership;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { chainId, to, value, data } = body as Record<string, unknown>;

  const resolvedChainId =
    typeof chainId === "number" ? chainId : Number(chainId ?? sepolia.id);
  if (!Number.isInteger(resolvedChainId) || resolvedChainId <= 0) {
    return Response.json(
      { error: "`chainId` must be a positive integer (default: Sepolia 11155111)" },
      { status: 400 },
    );
  }

  const provider = getProvider(ownership.provider);
  let address: `0x${string}` | undefined;
  try {
    const meta = await provider.getVault(id);
    address = meta.address;
  } catch (err) {
    return providerErrorToResponse(err);
  }
  if (!address) {
    return Response.json(
      {
        error:
          "This vault has no signing address attached. Only Orbitport-backed vaults expose signing in this iteration.",
      },
      { status: 400 },
    );
  }

  const targetTo: `0x${string}` = isHexAddress(to) ? to : address;

  let parsedValue: bigint;
  try {
    parsedValue = parseBigint(value, "value");
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "invalid value" },
      { status: 400 },
    );
  }

  if (data !== undefined && data !== null && data !== "" && !isHex(data)) {
    return Response.json(
      { error: "`data` must be a 0x-prefixed hex string" },
      { status: 400 },
    );
  }

  try {
    const result = await signAndSend(provider, id, {
      chainId: resolvedChainId,
      from: address,
      to: targetTo,
      value: parsedValue,
      data: isHex(data) ? data : "0x",
    });
    return Response.json({
      txHash: result.txHash,
      from: result.address,
      to: targetTo,
      chainId: resolvedChainId,
    });
  } catch (err) {
    // Surface the underlying error message (RPC/viem errors don't extend
    // ProviderError, so providerErrorToResponse would mask them as a 500).
    const message =
      err instanceof Error
        ? // viem errors expose `details` (concise) and `shortMessage` — prefer the
          // most actionable one.
          (err as Error & { details?: string; shortMessage?: string }).details ??
          (err as Error & { shortMessage?: string }).shortMessage ??
          err.message
        : "Failed to sign or broadcast transaction";
    console.error("[sign-test] failure", { vaultId: id, err });
    return Response.json({ error: message }, { status: 502 });
  }
}
