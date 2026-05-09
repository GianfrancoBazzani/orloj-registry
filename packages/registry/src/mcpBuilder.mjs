import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidName } from "./loader.mjs";

const TEMPLATE_INDEX_MJS = `import { z } from "zod";

export default function register(server) {
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the input text unchanged.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );
}
`;

export async function buildContractMcp(mcpsDir, chainId, address) {
  const name = `${chainId}-${address.toLowerCase()}`;
  if (!isValidName(name)) {
    throw new Error(`derived MCP name "${name}" is invalid`);
  }

  const targetDir = path.join(mcpsDir, name);
  const existing = await stat(targetDir).catch(() => null);
  if (existing?.isDirectory()) {
    return name;
  }

  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "index.mjs"), TEMPLATE_INDEX_MJS);
  return name;
}
