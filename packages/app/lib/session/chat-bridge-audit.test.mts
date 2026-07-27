import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectionRequiresRegistry } from "./selection-registry-policy.mjs";

const LP_MANAGER_MCP_ID = "orloj-lp-manager";
const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (rel) => import(pathToFileURL(path.join(here, rel)).href);

describe("selectionRequiresRegistry", () => {
  it("requires registry when uniswap is selected alongside LP Manager", () => {
    assert.equal(
      selectionRequiresRegistry(["uniswap", LP_MANAGER_MCP_ID], LP_MANAGER_MCP_ID),
      true,
    );
  });

  it("does not require registry for internal-only selection", () => {
    assert.equal(
      selectionRequiresRegistry([LP_MANAGER_MCP_ID], LP_MANAGER_MCP_ID),
      false,
    );
  });

  it("requires registry when internal MCP is not configured", () => {
    assert.equal(selectionRequiresRegistry([LP_MANAGER_MCP_ID], null), true);
  });
});

describe("mcpNameFromManagedUrl", async () => {
  const { mcpNameFromManagedUrl } = await load("./mcp-block.ts");
  const prev = process.env.LP_AGENT_MCP_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.LP_AGENT_MCP_URL;
    else process.env.LP_AGENT_MCP_URL = prev;
  });

  it("maps registry interface URLs", () => {
    assert.equal(
      mcpNameFromManagedUrl("http://127.0.0.1:3001/interface/uniswap/mcp"),
      "uniswap",
    );
  });

  it("maps configured LP_AGENT_MCP_URL to orloj-lp-manager", () => {
    process.env.LP_AGENT_MCP_URL = "http://127.0.0.1:3000/api/lp-agent/mcp";
    assert.equal(
      mcpNameFromManagedUrl("http://127.0.0.1:3000/api/lp-agent/mcp"),
      LP_MANAGER_MCP_ID,
    );
    assert.equal(
      mcpNameFromManagedUrl("http://127.0.0.1:3000/api/lp-agent/mcp/"),
      LP_MANAGER_MCP_ID,
    );
  });
});

describe("sidecar recovery for LP Manager URL", async () => {
  const { MANAGED_MARKER, readMcpSelection, writeMcpSelection } =
    await load("./mcp-block.ts");
  const prev = process.env.LP_AGENT_MCP_URL;
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    process.env.LP_AGENT_MCP_URL = "http://127.0.0.1:3000/api/lp-agent/mcp";
    dir = await mkdtemp(path.join(tmpdir(), "mcp-block-"));
    await writeFile(path.join(dir, "config.toml"), 'workspace_id = "x"\n\n', "utf8");
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.LP_AGENT_MCP_URL;
    else process.env.LP_AGENT_MCP_URL = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it("re-derives orloj-lp-manager when orloj-mcps.json is missing", async () => {
    await writeMcpSelection(dir, [
      {
        mcpName: "uniswap",
        serverName: "Uniswap",
        url: "http://127.0.0.1:3001/interface/uniswap/mcp",
        bearerToken: "tok",
      },
      {
        mcpName: LP_MANAGER_MCP_ID,
        serverName: "Graph_LP_Manager",
        url: "http://127.0.0.1:3000/api/lp-agent/mcp",
        bearerToken: "tok",
      },
    ]);
    await unlink(path.join(dir, "orloj-mcps.json"));

    const selection = await readMcpSelection(dir);
    assert.deepEqual(
      selection.map((s) => s.mcpName).sort(),
      [LP_MANAGER_MCP_ID, "uniswap"].sort(),
    );
    const config = await readFile(path.join(dir, "config.toml"), "utf8");
    assert.match(config, new RegExp(MANAGED_MARKER));
  });
});
