import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
import { z } from "zod";
import { getContract } from "./get-contract.js";

function findChain(chainId) {
  const id = Number(chainId);
  return (
    Object.values(viemChains).find(
      (c) => c && typeof c === "object" && "id" in c && c.id === id,
    ) ?? null
  );
}

const serialize = (_, v) => (typeof v === "bigint" ? v.toString() : v);

const ADDRESS_SCHEMA = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("Ethereum address");
const WEI_SCHEMA = z
  .string()
  .regex(/^\d+$/)
  .describe("Amount in wei (decimal string)");

function buildNativeTokenMcp({ chain, publicClient, walletClient, account }) {
  const chainId = chain.id;
  const name = `native_token_chain_id_${chainId}`;
  const symbol = chain.nativeCurrency?.symbol ?? "ETH";
  const decimals = chain.nativeCurrency?.decimals ?? 18;

  const server = new McpServer({ name, version: "1.0.0" });

  const balanceDoc = `Get the native ${symbol} balance of an address (in wei)`;
  const transferDoc = `Transfer native ${symbol} to an address`;

  server.tool(
    "balanceOf",
    balanceDoc,
    { address: ADDRESS_SCHEMA },
    async ({ address }) => {
      try {
        const balance = await publicClient.getBalance({ address });
        return {
          content: [
            { type: "text", text: JSON.stringify({ balance }, serialize, 2) },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "transfer",
    transferDoc,
    { to: ADDRESS_SCHEMA, value: WEI_SCHEMA },
    async ({ to, value }) => {
      if (!walletClient || !account) {
        return {
          content: [
            {
              type: "text",
              text: "Error: PRIVATE_KEY env var required to sign transactions",
            },
          ],
          isError: true,
        };
      }
      try {
        const request = await walletClient.prepareTransactionRequest({
          to,
          value: BigInt(value),
          account,
          chain,
        });
        const signedTx = await walletClient.signTransaction(request);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { signedTransaction: signedTx },
                serialize,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e}` }],
          isError: true,
        };
      }
    },
  );

  const tools = [
    { name: "balanceOf", type: "view", description: balanceDoc },
    { name: "transfer", type: "write", description: transferDoc },
  ];

  const meta = {
    chainId,
    address: false,
    implementation: false,
    contractName: name,
    version: "1.0.0",
    toolCount: tools.length,
    tools,
    nativeToken: true,
    symbol,
    decimals,
  };

  return { server, meta };
}

export async function buildMcp({ chainId, address, implementation, rpcUrl }) {
  const chain = findChain(chainId);
  if (!chain) {
    throw new Error(`unknown chainId ${chainId}: not found in viem/chains`);
  }

  const transport = http(rpcUrl || undefined, { timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport });

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const account = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;
  const walletClient = account
    ? createWalletClient({ account, chain, transport })
    : null;

  if (!address && !implementation) {
    return buildNativeTokenMcp({ chain, publicClient, walletClient, account });
  }

  const abiAddress = implementation || address;
  const contract = await getContract(address, chainId, {
    ignoreEvents: true,
    abiAddress,
  });

  const server = new McpServer({
    name: contract.name_contract,
    version: "1.0.0",
  });

  const tools = [];
  const registered = new Set();
  for (const fn of contract.functions) {
    if (registered.has(fn.name)) continue;
    registered.add(fn.name);

    if (fn.type === "view" || fn.type === "write") {
      tools.push({
        name: fn.name,
        type: fn.type,
        description: fn.doc || fn.name,
      });
    }

    if (fn.type === "view") {
      server.tool(
        fn.name,
        fn.doc || fn.name,
        fn.input.shape,
        async (args) => {
          try {
            const result = await fn.func(publicClient, args);
            return {
              content: [
                { type: "text", text: JSON.stringify(result, serialize, 2) },
              ],
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error: ${e}` }],
              isError: true,
            };
          }
        },
      );
      continue;
    }

    if (fn.type === "write") {
      server.tool(
        fn.name,
        fn.doc || fn.name,
        fn.input.shape,
        async (args) => {
          if (!walletClient || !account) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: PRIVATE_KEY env var required to sign transactions",
                },
              ],
              isError: true,
            };
          }
          try {
            const request = await walletClient.prepareTransactionRequest({
              to: address,
              data: fn.encodeData(args),
              account,
              chain,
            });
            const signedTx = await walletClient.signTransaction(request);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { signedTransaction: signedTx },
                    serialize,
                    2,
                  ),
                },
              ],
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `Error: ${e}` }],
              isError: true,
            };
          }
        },
      );
    }
  }

  const meta = {
    chainId: Number(chainId),
    address,
    implementation: implementation || null,
    contractName: contract.name_contract,
    version: "1.0.0",
    toolCount: tools.length,
    tools,
  };

  return { server, meta };
}
