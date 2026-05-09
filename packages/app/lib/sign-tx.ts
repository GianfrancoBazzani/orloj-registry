import {
  createPublicClient,
  http,
  keccak256,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { SUPPORTED_CHAINS, type SupportedChainKey } from "./chains";
import {
  ProviderError,
  type EthSignature,
  type VaultProvider,
} from "./vault-providers/types";

const KEY_BY_ID: Record<number, SupportedChainKey> = {
  [mainnet.id]: "mainnet",
  [sepolia.id]: "sepolia",
};

const resolveChainEntry = (chainId: number) => {
  const key = KEY_BY_ID[chainId];
  if (!key) {
    throw new ProviderError(
      `Unsupported chainId ${chainId}. Add it to SUPPORTED_CHAINS in lib/chains.ts.`,
      400,
    );
  }
  const entry = SUPPORTED_CHAINS[key];
  const perChainEnv = `ETH_RPC_URL_${key.toUpperCase()}`;
  const rpcUrl =
    process.env[perChainEnv] ?? process.env.ETH_RPC_URL ?? entry.defaultRpc;
  return { ...entry, rpcUrl };
};

export interface SignAndSendParams {
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
}

// Builds an EIP-1559 transaction, signs its digest via the given provider's
// remote KMS, assembles the broadcast hex, and submits it through the chain's
// RPC URL. Returns the resulting transaction hash.
export const signAndSend = async (
  provider: VaultProvider,
  vaultId: string,
  params: SignAndSendParams,
): Promise<{ txHash: Hex; signature: EthSignature; address: `0x${string}` }> => {
  const { chain, rpcUrl } = resolveChainEntry(params.chainId);

  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const ZERO = BigInt(0);

  const [nonce, gasPrice, gasLimit] = await Promise.all([
    client.getTransactionCount({ address: params.from, blockTag: "pending" }),
    client.estimateFeesPerGas(),
    params.gas !== undefined
      ? Promise.resolve(params.gas)
      : client.estimateGas({
          account: params.from,
          to: params.to,
          value: params.value ?? ZERO,
          data: params.data ?? "0x",
        }),
  ]);

  const unsigned: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: params.chainId,
    nonce,
    to: params.to,
    value: params.value ?? ZERO,
    data: params.data ?? "0x",
    gas: gasLimit,
    maxFeePerGas: gasPrice.maxFeePerGas,
    maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
  };

  const serialized = serializeTransaction(unsigned);
  const digest = keccak256(serialized);

  const signature = await provider.signDigest(vaultId, digest);

  // viem expects yParity (0 or 1) for EIP-1559 serialization. Normalize from 27/28.
  const yParity = signature.v >= 27 ? signature.v - 27 : signature.v;
  const signedHex = serializeTransaction(unsigned, {
    r: signature.r,
    s: signature.s,
    yParity,
  });

  const txHash = await client.sendRawTransaction({ serializedTransaction: signedHex });
  return { txHash, signature, address: params.from };
};
