import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, http, webSocket } from "viem";
import * as viemChains from "viem/chains";
import { z } from "zod";
import { getContract } from "./get-contract.js";
import { signTransaction } from "./sign-transaction.js";
import { logToolCall } from "./log-tool-call.mjs";

function withLogging(ctx, handler) {
  return async (args) => {
    let status = "ok";
    let resultSummary = null;
    let errorMessage = null;
    try {
      const result = await handler(args);
      if (result?.isError) {
        status = "error";
        errorMessage = String(result?.content?.[0]?.text ?? "");
      } else if (typeof result?.content?.[0]?.text === "string") {
        resultSummary = result.content[0].text;
      }
      await logToolCall({ ...ctx, args, status, resultSummary, errorMessage });
      return result;
    } catch (e) {
      await logToolCall({
        ...ctx,
        args,
        status: "error",
        resultSummary: null,
        errorMessage: String(e?.message ?? e),
      });
      throw e;
    }
  };
}

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

function buildNativeTokenServer({ chain, publicClient, agentId, mcpName, contractName }) {
  const chainId = chain.id;
  const name = `native_token_chain_id_${chainId}`;
  const symbol = chain.nativeCurrency?.symbol ?? "ETH";

  const server = new McpServer({
    name,
    version: "1.0.0",
    instructions: `This MCP provides direct access to native ${symbol} token operations on ${chain.name}. All blockchain-specific details (private key management, gas estimation, transaction signing) are abstracted away. You can call balanceOf() and transfer() directly as if interacting with the blockchain—the system handles key management and transaction submission automatically. No need to manage private keys, compute gas, or construct raw transactions.`,
  });

  const balanceDoc = `Get the native ${symbol} balance of an address (in wei)`;
  const transferDoc = `Transfer native ${symbol} to an address`;

  server.tool(
    "balanceOf",
    balanceDoc,
    { address: ADDRESS_SCHEMA },
    withLogging(
      { agentId, mcpName, contractName, toolName: "balanceOf" },
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
    ),
  );

  server.tool(
    "transfer",
    transferDoc,
    { to: ADDRESS_SCHEMA, value: WEI_SCHEMA },
    withLogging(
      { agentId, mcpName, contractName, toolName: "transfer" },
      async ({ to, value }) => {
        try {
          const serializedTransaction = await signTransaction({
            agentId,
            chain,
            publicClient,
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
    ),
  );

  return server;
}

function buildContractServer({ chain, publicClient, contract, address, agentId, mcpName, contractName }) {
  const server = new McpServer({
    name: contract.name_contract,
    version: "1.0.0",
    instructions: `This MCP provides contract function calls for ${contract.name_contract} deployed at ${address} on ${chain.name}. All blockchain complexities are handled transparently: private key management, gas estimation, and transaction signing are abstracted away. Call any contract function directly as if it were a local method. Read functions return contract state immediately. Write functions submit transactions automatically—just provide the function parameters and let the MCP handle signing and submission. No manual transaction construction or key management required.`,
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
        withLogging(
          { agentId, mcpName, contractName, toolName: fn.name },
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
        ),
      );
      continue;
    }

    if (fn.type === "write") {
      server.tool(
        fn.name,
        fn.doc || fn.name,
        { ...fn.input.shape, native_gas_token_value: WEI_SCHEMA.optional() },
        withLogging(
          { agentId, mcpName, contractName, toolName: fn.name },
          async (args) => {
            try {
              const { native_gas_token_value, ...contractArgs } = args;
              const serializedTransaction = await signTransaction({
                agentId,
                chain,
                publicClient,
                to: address,
                data: fn.encodeData(contractArgs),
                value: native_gas_token_value ? BigInt(native_gas_token_value) : 0n,
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
        ),
      );
    }
  }

  return server;
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
    const symbol = chain.nativeCurrency?.symbol ?? "ETH";
    const decimals = chain.nativeCurrency?.decimals ?? 18;
    const name = `native_token_chain_id_${chain.id}`;
    const tools = [
      {
        name: "balanceOf",
        type: "view",
        description: `Get the native ${symbol} balance of an address (in wei)`,
      },
      {
        name: "transfer",
        type: "write",
        description: `Transfer native ${symbol} to an address`,
      },
    ];
    const meta = {
      chainId: chain.id,
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
    return {
      meta,
      build: ({ agentId, mcpName }) =>
        buildNativeTokenServer({
          chain,
          publicClient,
          agentId,
          mcpName,
          contractName: `Native ${symbol}`,
        }),
    };
  }

  const abiAddress = implementation || address;
  const contract = await getContract(address, chainId, {
    ignoreEvents: true,
    abiAddress,
  });

  const seen = new Set();
  const tools = [];
  for (const fn of contract.functions) {
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    if (fn.type === "view" || fn.type === "write") {
      tools.push({
        name: fn.name,
        type: fn.type,
        description: fn.doc || fn.name,
      });
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

  return {
    meta,
    build: ({ agentId, mcpName }) =>
      buildContractServer({
        chain,
        publicClient,
        contract,
        address,
        agentId,
        mcpName,
        contractName: contract.name_contract,
      }),
  };
}
