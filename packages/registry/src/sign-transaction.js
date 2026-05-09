import { encodePacked, hashMessage } from "viem";

// EIP-191 reference: https://eips.ethereum.org/EIPS/eip-191
//
// Centralized signing entrypoint. Takes canonical transaction data, derives
// the EIP-191 personal_sign (version 0x45) digest, defers to the external
// signer for the ECDSA signature, and returns a broadcastable serialized
// transaction ready for `publicClient.sendRawTransaction`.
export async function signTransaction({
  chain,
  to,
  value = 0n,
  data = "0x",
  nonce = 0n,
}) {
  // keccak256("\x19Ethereum Signed Message:\n" || len(msg) || msg)
  // chainId is included in the message body for cross-chain replay protection.
  const digest = hashMessage({
    raw: encodePacked(
      ["uint256", "address", "uint256", "bytes", "uint256"],
      [BigInt(chain.id), to, BigInt(value), data, BigInt(nonce)],
    ),
  });

  // TODO: forward `digest` to the external signer (wallet / HSM / relayer)
  // and combine the returned (r, s, v) signature with the tx fields into an
  // RLP-encoded signed transaction.
  void digest;
  return "0x"; // placeholder serialized signed transaction
}
