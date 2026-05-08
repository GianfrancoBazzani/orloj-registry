import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { stat } from "node:fs/promises";
import path from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidName(name) {
  return NAME_RE.test(name);
}

export async function loadMcp(mcpsDir, name) {
  if (!isValidName(name)) {
    throw new Error(
      `invalid MCP name "${name}" (must match ${NAME_RE})`,
    );
  }

  const entryPath = path.join(mcpsDir, name, "index.mjs");

  const entryStat = await stat(entryPath).catch(() => null);
  if (!entryStat?.isFile()) {
    throw new Error(`missing entry file: ${entryPath}`);
  }

  const url = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
  const mod = await import(url);

  const register = mod.default;
  if (typeof register !== "function") {
    throw new Error(
      `${entryPath}: default export must be a function (server) => void`,
    );
  }

  const server = new McpServer({ name, version: "1.0.0" });
  await register(server);
  return server;
}
