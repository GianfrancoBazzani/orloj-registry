import fs from "fs";
import path from "path";
import * as viemChains from "viem/chains";

function findChainExport(chainId) {
  const entry = Object.entries(viemChains).find(
    ([_, v]) => v && typeof v === "object" && "id" in v && v.id === Number(chainId)
  );
  return entry?.[0] ?? null;
}

function generateServerFile(address, chainId, chainExport, rpcUrl) {
  const chainImport = chainExport
    ? `import { ${chainExport} as chain } from "viem/chains";`
    : `import { defineChain } from "viem";\nconst chain = defineChain({ id: ${chainId}, name: "Chain ${chainId}", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });`;

  return `\
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
${chainImport}
import { getContract } from "../../../../get-contract.js";

const ADDRESS = "${address}";
const CHAIN_ID = "${chainId}";
const RPC_URL = "${rpcUrl ?? ""}";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env var required");

const account = privateKeyToAccount(PRIVATE_KEY);
const transport_http = http(RPC_URL || undefined, { timeout: 10_000 });
const publicClient = createPublicClient({ chain, transport: transport_http });
const walletClient = createWalletClient({ account, chain, transport: transport_http });

const contract = await getContract(ADDRESS, CHAIN_ID, { ignoreEvents: true });

const server = new McpServer({
  name: contract.name_contract,
  version: "1.0.0",
});

const serialize = (_, v) => (typeof v === "bigint" ? v.toString() : v);

const registered = new Set();
for (const fn of contract.functions) {
  if (registered.has(fn.name)) continue;
  registered.add(fn.name);
  if (fn.type === "view") {
    server.tool(fn.name, fn.doc || fn.name, fn.input.shape, async (args) => {
      try {
        const result = await fn.func(publicClient, args);
        return { content: [{ type: "text", text: JSON.stringify(result, serialize, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e}\` }], isError: true };
      }
    });
  }

  if (fn.type === "write") {
    server.tool(fn.name, fn.doc || fn.name, fn.input.shape, async (args) => {
      try {
        const request = await walletClient.prepareTransactionRequest({
          to: ADDRESS,
          data: fn.encodeData(args),
          account,
          chain,
        });
        const signedTx = await walletClient.signTransaction(request);

        return { content: [{ type: "text", text: JSON.stringify({ signedTransaction: signedTx }, serialize, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: \`Error: \${e}\` }], isError: true };
      }
    });
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

export async function generateMcp(address, chainId, rpcUrl) {
  const chainExport = findChainExport(chainId);

  const dir = path.join("mcps", "contracts", chainId, address);
  fs.mkdirSync(dir, { recursive: true });

  const content = generateServerFile(address, chainId, chainExport, rpcUrl);
  const outFile = path.join(dir, "index.js");
  fs.writeFileSync(outFile, content);

  console.log(`Generated: ${outFile}`);
  console.log(`Run with:  node ${outFile}`);
}

// ---- CLI ----

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const [address, chainId, rpcUrl] = process.argv.slice(2);

  if (!address || !chainId) {
    console.error("Usage: node generate_mcp.js <address> <chainId> [rpcUrl]");
    process.exit(1);
  }

  await generateMcp(address, chainId, rpcUrl);
  process.exit(0);
}
