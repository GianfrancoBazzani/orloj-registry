#!/usr/bin/env node
// Phase-0 capability spike for SpaceComputer Orbitport KMS.
//
// What this proves:
//   1. We can authenticate (OAuth client-credentials).
//   2. We can create an ETHEREUM-scheme key and read its address.
//   3. messageType=DIGEST + signingAlgorithm=ETHEREUM_SECP256K1 returns a
//      signature whose recovered address matches the key's address — i.e.
//      DIGEST mode does NOT prefix with EIP-191. This is the load-bearing
//      assumption behind the entire Orbitport tx-signing path.
//
// Run from packages/app/:
//   ORBITPORT_CLIENT_ID=... ORBITPORT_CLIENT_SECRET=... node scripts/orbitport-spike.mjs
//
// Optional env:
//   ORBITPORT_AUTH_DOMAIN  default: auth.spacecomputer.io
//   ORBITPORT_AUDIENCE     default: https://op.spacecomputer.io/api
//   ORBITPORT_API_URL      default: https://op.spacecomputer.io
//   ORBITPORT_KEY_ALIAS    default: orloj-spike-<timestamp>
//
// Exits non-zero on any failure. On success, prints the recovered address
// alongside the key's address; they MUST match.

import { keccak256, recoverAddress, serializeTransaction, toHex } from "viem";

const AUTH_DOMAIN = process.env.ORBITPORT_AUTH_DOMAIN || "auth.spacecomputer.io";
const AUDIENCE = process.env.ORBITPORT_AUDIENCE || "https://op.spacecomputer.io/api";
const API_URL = process.env.ORBITPORT_API_URL || "https://op.spacecomputer.io";
const CLIENT_ID = process.env.ORBITPORT_CLIENT_ID;
const CLIENT_SECRET = process.env.ORBITPORT_CLIENT_SECRET;
const KEY_ALIAS = process.env.ORBITPORT_KEY_ALIAS || `orloj-spike-${Date.now()}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing ORBITPORT_CLIENT_ID / ORBITPORT_CLIENT_SECRET. Aborting.",
  );
  process.exit(2);
}

const log = (...args) => console.log("·", ...args);

// ---------- 1. OAuth ----------
log("step 1 — OAuth client_credentials at", `https://${AUTH_DOMAIN}/oauth/token`);
const tokenRes = await fetch(`https://${AUTH_DOMAIN}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    audience: AUDIENCE,
  }),
});
if (!tokenRes.ok) {
  console.error("OAuth failed:", tokenRes.status, await tokenRes.text());
  process.exit(1);
}
const { access_token } = await tokenRes.json();
log("got access_token (len", access_token.length, ")");

// ---------- shared JSON-RPC ----------
let rpcId = 1;
const rpc = async (method, params) => {
  const res = await fetch(`${API_URL}/api/v1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `${method} → HTTP ${res.status} (non-JSON response):\n${text}`,
    );
  }
  if (json.error) {
    throw new Error(`${method} → ${JSON.stringify(json.error)}`);
  }
  return json.result;
};

// ---------- 2. createKey ----------
log("step 2 — kms.CreateKey ETHEREUM / ECC_SECG_P256K1, alias =", KEY_ALIAS);
const created = await rpc("kms.CreateKey", {
  Alias: KEY_ALIAS,
  KeySpec: "ECC_SECG_P256K1",
  KeyUsage: "SIGN_VERIFY",
  Scheme: "ETHEREUM",
  Description: `Orloj capability spike (${new Date().toISOString()})`,
  Tags: [],
});
const keyMeta = created.KeyMetadata;
const keyId = keyMeta.KeyId;
const keyAddress = (keyMeta.Address || "").toLowerCase();
log("KeyId   :", keyId);
log("Address :", keyAddress);
if (!keyAddress?.startsWith("0x")) {
  console.error("Created key did not return an Address. Cannot proceed.");
  process.exit(1);
}

// ---------- 3. build a known unsigned tx and digest it ----------
const unsignedTx = {
  type: "eip1559",
  chainId: 11155111, // Sepolia
  nonce: 0,
  to: keyAddress, // self-send for simplicity
  value: 0n,
  data: "0x",
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  gas: 21_000n,
};
const serialized = serializeTransaction(unsignedTx);
const digest = keccak256(serialized);
log("step 3 — built unsigned tx, digest =", digest);

// ---------- 4. sign(DIGEST) ----------
const digestBytes = Uint8Array.from(
  digest.slice(2).match(/.{2}/g).map((h) => parseInt(h, 16)),
);
const messageB64 = Buffer.from(digestBytes).toString("base64");

log("step 4 — kms.Sign messageType=DIGEST signingAlgorithm=ETHEREUM_SECP256K1");
const signed = await rpc("kms.Sign", {
  KeyId: keyId,
  Message: messageB64,
  SigningAlgorithm: "ETHEREUM_SECP256K1",
  MessageType: "DIGEST",
});

const sigRaw = signed.Signature;
log("Signature wire shape =", typeof sigRaw, "len", sigRaw.length);
log("Signature first 80 chars:", sigRaw.slice(0, 80));

// The Orbitport gateway returns the signature as a hex string (with or
// without `0x` prefix), not base64. We detect the format and decode
// accordingly so we're robust to either.
const decodeSignature = (raw) => {
  const hexBody = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length === 130) {
    return Buffer.from(hexBody, "hex");
  }
  // Fallback: try base64.
  return Buffer.from(raw, "base64");
};

const sigBytes = decodeSignature(sigRaw);
log("Signature decoded (", sigBytes.length, "bytes )");
if (sigBytes.length !== 65) {
  console.error(
    "Expected 65-byte signature (r||s||v). Got",
    sigBytes.length,
    "bytes. Wire format is unexpected — see raw value above.",
  );
  process.exit(1);
}

const r = toHex(sigBytes.subarray(0, 32));
const s = toHex(sigBytes.subarray(32, 64));
const vRaw = sigBytes[64];
// v is either 0/1 (yParity) or 27/28. Normalize to 27/28 for recoverAddress hex form.
const v = vRaw < 27 ? 27 + vRaw : vRaw;
log("r =", r);
log("s =", s);
log("v =", v, "(raw byte", vRaw, ")");

// ---------- 5. recover address ----------
const sigHex = `0x${sigBytes.subarray(0, 64).toString("hex")}${v.toString(16)}`;
const recovered = (
  await recoverAddress({ hash: digest, signature: sigHex })
).toLowerCase();
log("step 5 — recovered address:", recovered);

if (recovered !== keyAddress) {
  console.error(
    "\n❌ Recovered address does not match key address. DIGEST mode is incompatible — abort the swap and revisit the plan.",
  );
  process.exit(1);
}

console.log(
  "\n✅ Phase-0 spike PASSED. DIGEST-mode signing recovers the correct address.",
);
console.log("   Key alias:", KEY_ALIAS);
console.log("   Key id   :", keyId);
console.log("   Address  :", keyAddress);
