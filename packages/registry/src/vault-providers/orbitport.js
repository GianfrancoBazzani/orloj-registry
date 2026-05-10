import {
  hexToBytes,
  keccak256,
  serializeTransaction,
} from "viem";
import { OrbitportSDK } from "@spacecomputer-io/orbitport-sdk-ts";

let sdkPromise = null;

export async function getOrbitportSdk() {
  if (sdkPromise) return sdkPromise;

  const clientId = process.env.ORBITPORT_CLIENT_ID;
  const clientSecret = process.env.ORBITPORT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "ORBITPORT_CLIENT_ID / ORBITPORT_CLIENT_SECRET are not set.",
    );
  }

  sdkPromise = (async () =>
    new OrbitportSDK({ config: { clientId, clientSecret } }))().catch((err) => {
    sdkPromise = null;
    throw err;
  });

  return sdkPromise;
}

// Orbitport returns signatures as hex strings (with or without `0x`).
// Accept both, with a base64 fallback in case the wire format changes.
function decodeSignature(raw) {
  const hexBody =
    raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length === 130) {
    return Buffer.from(hexBody, "hex");
  }
  return Buffer.from(raw, "base64");
}

// Build an EIP-1559 tx, hash it, ask Orbitport KMS to sign the digest,
// then re-serialize with the signature. Returns broadcastable 0x hex.
export async function signWithOrbitport({
  kmsSigningKeyId,
  address,
  chain,
  publicClient,
  to,
  value = 0n,
  data = "0x",
  nonce,
}) {
  const [resolvedNonce, fees, gas] = await Promise.all([
    nonce !== undefined
      ? Promise.resolve(BigInt(nonce))
      : publicClient
          .getTransactionCount({ address, blockTag: "pending" })
          .then(BigInt),
    publicClient.estimateFeesPerGas(),
    publicClient.estimateGas({ account: address, to, value, data }),
  ]);

  const unsigned = {
    type: "eip1559",
    chainId: chain.id,
    nonce: Number(resolvedNonce),
    to,
    value,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  const serialized = serializeTransaction(unsigned);
  const digest = keccak256(serialized);
  const messageBytes = hexToBytes(digest);

  const sdk = await getOrbitportSdk();
  const res = await sdk.kms.sign({
    keyId: kmsSigningKeyId,
    message: messageBytes,
    signingAlgorithm: "ETHEREUM_SECP256K1",
    messageType: "DIGEST",
  });

  const sig = decodeSignature(res.data.Signature);
  if (sig.length !== 65) {
    throw new Error(
      `Orbitport signature has unexpected length ${sig.length} (want 65)`,
    );
  }
  const r = `0x${sig.subarray(0, 32).toString("hex")}`;
  const s = `0x${sig.subarray(32, 64).toString("hex")}`;
  const vRaw = sig[64];
  const v = vRaw < 27 ? 27 + vRaw : vRaw;
  const yParity = v - 27;

  return serializeTransaction(unsigned, { r, s, yParity });
}
