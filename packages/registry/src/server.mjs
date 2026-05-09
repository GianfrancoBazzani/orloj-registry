import express from "express";
import cors from "cors";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as registry from "./registry.mjs";
import { buildMcp } from "./generate-mcp.js";
import { requireBearer } from "./auth.mjs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const CONTRACTS_FILE = path.resolve(
  PACKAGE_ROOT,
  process.env.CONTRACTS_FILE ?? "./contracts.json",
);

function entryName({ chainId, address, implementation }) {
  if (address === false && implementation === false) {
    return `native_token_chain_id_${Number(chainId)}`;
  }
  return `${chainId}-${address.toLowerCase()}`;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, count: registry.list().length });
});

app.get("/mcp", (_req, res) => {
  const items = registry.entriesList().map(({ name, meta }) => {
    const { tools: _tools, ...rest } = meta;
    return {
      name,
      url: `/interface/${name}/mcp`,
      ...rest,
    };
  });
  res.json(items);
});

app.post("/register", async (req, res) => {
  const { chainId, address, rpcUrl } = req.body ?? {};

  if (!Number.isFinite(Number(chainId))) {
    res.status(400).json({ error: "chainId must be a number" });
    return;
  }
  if (!ADDRESS_RE.test(address ?? "")) {
    res.status(400).json({ error: "address must be 0x-prefixed 20-byte hex" });
    return;
  }
  if (rpcUrl != null && (typeof rpcUrl !== "string" || rpcUrl.length === 0)) {
    res.status(400).json({ error: "rpcUrl must be a non-empty string" });
    return;
  }

  const numericChainId = Number(chainId);

  try {
    const sourcifyUrl = `https://sourcify.dev/server/v2/contract/${numericChainId}/${address.toLowerCase()}?fields=proxyResolution`;
    const sourcifyRes = await fetch(sourcifyUrl);
    if (!sourcifyRes.ok) {
      const body = await sourcifyRes.text();
      res.status(502).json({
        error: `Sourcify ${sourcifyRes.status}: ${body}`,
      });
      return;
    }
    const data = await sourcifyRes.json();
    const proxyResolution = data?.proxyResolution ?? {};
    const implAddress = proxyResolution?.implementations?.[0]?.address;
    const implementation =
      proxyResolution.isProxy && ADDRESS_RE.test(implAddress ?? "")
        ? implAddress
        : false;

    const raw = await readFile(CONTRACTS_FILE, "utf8");
    const contracts = JSON.parse(raw);
    if (!Array.isArray(contracts)) {
      throw new Error("contracts.json must be a JSON array");
    }
    const entry = { chainId: numericChainId, address, implementation };
    if (rpcUrl) entry.rpcUrl = rpcUrl;
    const existingIdx = contracts.findIndex(
      (c) =>
        Number(c?.chainId) === numericChainId &&
        typeof c?.address === "string" &&
        c.address.toLowerCase() === address.toLowerCase(),
    );
    if (existingIdx >= 0) {
      contracts[existingIdx] = entry;
    } else {
      contracts.push(entry);
    }
    await writeFile(
      CONTRACTS_FILE,
      `${JSON.stringify(contracts, null, 4)}\n`,
      "utf8",
    );

    const impl = typeof implementation === "string" ? implementation : null;
    const name = entryName({ chainId: numericChainId, address });
    const built = await buildMcp({
      chainId: numericChainId,
      address,
      implementation: impl,
      rpcUrl: rpcUrl || undefined,
    });
    await registry.set(name, built);
    console.log(
      `[registry] registered "${name}"${impl ? ` (proxy → ${impl})` : ""}`,
    );

    res.json({
      name,
      chainId: numericChainId,
      address,
      implementation,
      rpcUrl: rpcUrl || null,
      url: `/interface/${name}/mcp`,
    });
  } catch (err) {
    console.error(`[registry] /register error:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/interface/:name/mcp", requireBearer, async (req, res) => {
  const { name } = req.params;
  const entry = registry.get(name);
  if (!entry) {
    res.status(404).json({ error: "MCP not found" });
    return;
  }
  console.log(`[mcp] ${name} agent=${req.auth.agentId}`);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await entry.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[registry] request error for "${name}":`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    }
  }
});

async function registerContracts() {
  const raw = await readFile(CONTRACTS_FILE, "utf8");
  const contracts = JSON.parse(raw);
  if (!Array.isArray(contracts)) {
    throw new Error("contracts.json must be a JSON array");
  }

  for (const entry of contracts) {
    const { chainId, address, implementation, rpcUrl } = entry ?? {};
    if (!Number.isFinite(Number(chainId))) {
      console.error(`[registry] skipping invalid entry:`, entry);
      continue;
    }
    const isNative = address === false && implementation === false;
    if (!isNative && !ADDRESS_RE.test(address ?? "")) {
      console.error(`[registry] skipping invalid entry:`, entry);
      continue;
    }
    const impl =
      typeof implementation === "string" && ADDRESS_RE.test(implementation)
        ? implementation
        : null;
    const name = entryName({ chainId, address, implementation });
    try {
      const built = await buildMcp({
        chainId,
        address: isNative ? false : address,
        implementation: isNative ? false : impl,
        rpcUrl: typeof rpcUrl === "string" && rpcUrl.length > 0 ? rpcUrl : undefined,
      });
      await registry.set(name, built);
      console.log(
        `[registry] registered "${name}"${isNative ? " (native token)" : impl ? ` (proxy → ${impl})` : ""}`,
      );
    } catch (err) {
      console.error(`[registry] failed to register "${name}":`, err.message);
    }
  }
}

async function main() {
  console.log(`[registry] contracts file: ${CONTRACTS_FILE}`);
  await registerContracts();
  app.listen(PORT, () => {
    console.log(`[registry] listening on http://localhost:${PORT}`);
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
