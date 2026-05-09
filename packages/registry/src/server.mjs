import express from "express";
import cors from "cors";
import path from "node:path";
import { stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as registry from "./registry.mjs";
import { loadMcp, isValidName } from "./loader.mjs";
import { watchMcps } from "./watcher.mjs";
import { buildContractMcp } from "./mcpBuilder.mjs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const MCPS_DIR = path.resolve(
  PACKAGE_ROOT,
  process.env.MCPS_DIR ?? "./mcps",
);

async function syncMcp(name) {
  const folderStat = await stat(path.join(MCPS_DIR, name)).catch(() => null);
  if (!folderStat?.isDirectory()) {
    await removeMcp(name);
    return;
  }
  try {
    const server = await loadMcp(MCPS_DIR, name);
    await registry.set(name, server);
    console.log(`[registry] loaded "${name}"`);
  } catch (err) {
    if (registry.get(name)) {
      console.error(
        `[registry] reload failed for "${name}", keeping previous version:`,
        err.message,
      );
    } else {
      console.error(
        `[registry] load failed for "${name}":`,
        err.message,
      );
    }
  }
}

async function removeMcp(name) {
  if (await registry.remove(name)) {
    console.log(`[registry] removed "${name}"`);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, count: registry.list().length });
});

app.get("/mcp", (_req, res) => {
  const items = registry.list().map((name) => ({
    name,
    url: `/interface/${name}/mcp`,
  }));
  res.json(items);
});

app.post("/interface/:name/mcp", async (req, res) => {
  const { name } = req.params;
  if (!isValidName(name)) {
    res.status(404).json({ error: "MCP not found" });
    return;
  }
  const mcpServer = registry.get(name);
  if (!mcpServer) {
    res.status(404).json({ error: "MCP not found" });
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[registry] request error for "${name}":`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    }
  }
});

app.post("/register", async (req, res) => {
  const { networkId, address } = req.body ?? {};
  const networkIdNum =
    typeof networkId === "number" ? networkId : Number.parseInt(networkId, 10);
  if (!Number.isInteger(networkIdNum) || networkIdNum < 0) {
    res
      .status(400)
      .json({ error: "networkId must be a non-negative integer" });
    return;
  }
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    res
      .status(400)
      .json({ error: "address must be a 0x-prefixed 40-char hex string" });
    return;
  }

  let name;
  try {
    name = await buildContractMcp(MCPS_DIR, networkIdNum, address);
  } catch (err) {
    console.error(`[registry] build failed:`, err);
    res.status(500).json({ error: "failed to build MCP package" });
    return;
  }
  await syncMcp(name);
  if (!registry.get(name)) {
    res.status(500).json({ error: `failed to load MCP "${name}"` });
    return;
  }
  console.log(`[registry] registered "${name}"`);
  res.status(201).json({
    name,
    url: `/interface/${name}/mcp`,
    networkId: networkIdNum,
    address: address.toLowerCase(),
  });
});

async function main() {
  const dirStat = await stat(MCPS_DIR).catch(() => null);
  if (!dirStat?.isDirectory()) {
    console.error(`[registry] MCPS_DIR does not exist: ${MCPS_DIR}`);
    process.exit(1);
  }

  const initialEntries = await readdir(MCPS_DIR, { withFileTypes: true });
  await Promise.all(
    initialEntries
      .filter((e) => e.isDirectory())
      .map((e) => syncMcp(e.name)),
  );

  const watcher = watchMcps(MCPS_DIR, {
    onSync: syncMcp,
    onRemove: removeMcp,
  });
  await watcher.ready;

  app.listen(PORT, () => {
    console.log(`[registry] listening on http://localhost:${PORT}`);
    console.log(`[registry] watching ${MCPS_DIR}`);
    const loaded = registry.list();
    console.log(
      `[registry] ${loaded.length} MCP(s) loaded: ${loaded.join(", ") || "(none)"}`,
    );
  });
}

main().catch((err) => {
  console.error("[registry] fatal:", err);
  process.exit(1);
});
