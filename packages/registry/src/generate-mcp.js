import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
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

export async function buildMcp({ chainId, address, implementation, rpcUrl }) {
  const chain = findChain(chainId);
  if (!chain) {
    throw new Error(`unknown chainId ${chainId}: not found in viem/chains`);
  }

  const abiAddress = implementation || address;
  const contract = await getContract(address, chainId, {
    ignoreEvents: true,
    abiAddress,
  });

  const transport = http(rpcUrl || undefined, { timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport });

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const account = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;
  const walletClient = account
    ? createWalletClient({ account, chain, transport })
    : null;

  const server = new McpServer({
    name: contract.name_contract,
    version: "1.0.0",
  });

  const registered = new Set();
  for (const fn of contract.functions) {
    if (registered.has(fn.name)) continue;
    registered.add(fn.name);

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

  return server;
}
