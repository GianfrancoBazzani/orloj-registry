import express from "express";
import cors from "cors";
import path from "node:path";
import { stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as registry from "./registry.mjs";
import { loadMcp, isValidName } from "./loader.mjs";
import { watchMcps } from "./watcher.mjs";

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
    url: `/${name}/mcp`,
  }));
  res.json(items);
});

app.post("/:name/mcp", async (req, res) => {
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
