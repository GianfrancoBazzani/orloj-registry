import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, http, webSocket } from "viem";
import * as viemChains from "viem/chains";
import { z } from "zod";
import { getContract } from "./get-contract.js";
import { signTransaction } from "./sign-transaction.js";

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

function buildNativeTokenMcp({ chain, publicClient }) {
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
      try {
        const serializedTransaction = await signTransaction({
          chain,
          to,
          value: BigInt(value),
        });
        const hash = await publicClient.sendRawTransaction({
          serializedTransaction,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ hash }, serialize, 2) },
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

  const isWs = typeof rpcUrl === "string" && /^wss?:\/\//i.test(rpcUrl);
  const transport = isWs
    ? webSocket(rpcUrl)
    : http(rpcUrl || undefined, { timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport });

  if (!address && !implementation) {
    return buildNativeTokenMcp({ chain, publicClient });
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
          try {
            const serializedTransaction = await signTransaction({
              chain,
              to: address,
              data: fn.encodeData(args),
            });
            const hash = await publicClient.sendRawTransaction({
              serializedTransaction,
            });
            return {
              content: [
                { type: "text", text: JSON.stringify({ hash }, serialize, 2) },
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
