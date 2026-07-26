import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  ANALYZE_TOOL,
  MANAGE_TOOL,
  buildTrustedChatConfig,
  createLpAgentMcpDispatcher,
  resetAgentCycleLocksForTests,
  safeAgentStateKey,
  stateFilePathForAgent,
} from "../src/index.mjs";

function baseBuildFields(stateDir) {
  return {
    orlojMcpUrl: "http://127.0.0.1:3001/interface/uniswap/mcp",
    orlojBearerToken: "mcpk_live_test_secret_token",
    theGraphApiKey: "graph-secret-key",
    aiChatCompletionsUrl: "https://example.test/v1/chat/completions",
    aiApiKey: "ai-secret-key",
    aiModel: "test-model",
    stateDir,
  };
}

describe("chat-bridge trusted config + state paths", () => {
  /** @type {string} */
  let stateDir;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lp-chat-"));
    resetAgentCycleLocksForTests();
  });

  afterEach(() => {
    resetAgentCycleLocksForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("hashes agent ids into distinct safe state paths", () => {
    const a = stateFilePathForAgent(stateDir, "agent-a");
    const b = stateFilePathForAgent(stateDir, "agent-b");
    assert.notEqual(a, b);
    assert.equal(a, join(stateDir, `${safeAgentStateKey("agent-a")}.json`));
    assert.match(safeAgentStateKey("agent-a"), /^[a-f0-9]{64}$/);
  });

  it("forces observe/execute, null nft, Sepolia, and allowCreateRetry=false", () => {
    const config = buildTrustedChatConfig({
      ...baseBuildFields(stateDir),
      agentId: "agent-1",
      agentMode: "observe",
    });
    assert.equal(config.agentMode, "observe");
    assert.equal(config.nftTokenId, null);
    assert.equal(config.chainId, "11155111");
    assert.equal(config.allowCreateRetry, false);
    assert.equal(config.allowCreateRetryCycleId, null);
    assert.equal(config.orlojMcpApiKey, "mcpk_live_test_secret_token");
  });
});

describe("lp-agent MCP dispatcher", () => {
  /** @type {string} */
  let stateDir;
  /** @type {object[]} */
  let runCalls;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lp-disp-"));
    resetAgentCycleLocksForTests();
    runCalls = [];
  });

  afterEach(() => {
    resetAgentCycleLocksForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeDispatcher(overrides = {}) {
    return createLpAgentMcpDispatcher({
      agentId: "agent-chat-1",
      executeEnabled: false,
      buildConfig: async () => baseBuildFields(stateDir),
      runOnceFn: async (deps) => {
        runCalls.push(deps);
        return {
          status: "ok",
          phase: 1,
          agentMode: deps.config.agentMode,
          discovery: { count: 0 },
          results: [],
          leakedSecret: deps.config.orlojMcpApiKey,
        };
      },
      ...overrides,
    });
  }

  it("initialize returns protocol envelope", async () => {
    const { dispatch } = makeDispatcher();
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.equal(res.result.serverInfo.name, "orloj-lp-manager");
    assert.match(res.result.instructions, /observe/i);
  });

  it("tools/list includes analyze and omits manage when execute disabled", async () => {
    const { dispatch } = makeDispatcher({ executeEnabled: false });
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual(names, [ANALYZE_TOOL]);
  });

  it("tools/list includes manage when execute enabled", async () => {
    const { dispatch } = makeDispatcher({ executeEnabled: true });
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual(names, [ANALYZE_TOOL, MANAGE_TOOL]);
  });

  it("analyze always invokes runOnce with observe config", async () => {
    const { dispatch } = makeDispatcher();
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: ANALYZE_TOOL,
        arguments: {
          agentMode: "execute",
          chainId: "1",
          nftTokenId: "99",
          ORLOJ_AGENT_BEARER_TOKEN: "attacker",
          LP_AGENT_ALLOW_CREATE_RETRY: "true",
          stateFilePath: "/tmp/evil.json",
        },
      },
    });
    assert.equal(res.result.isError, false);
    assert.equal(runCalls.length, 1);
    const cfg = runCalls[0].config;
    assert.equal(cfg.agentMode, "observe");
    assert.equal(cfg.chainId, "11155111");
    assert.equal(cfg.nftTokenId, null);
    assert.equal(cfg.allowCreateRetry, false);
    assert.equal(cfg.orlojMcpApiKey, "mcpk_live_test_secret_token");
    assert.notEqual(cfg.stateFilePath, "/tmp/evil.json");
    const text = JSON.parse(res.result.content[0].text);
    assert.equal(text.agentMode, "observe");
    assert.equal(text.leakedSecret, "[REDACTED]");
  });

  it("manage supplies execute only when enabled", async () => {
    const disabled = makeDispatcher({ executeEnabled: false });
    const denied = await disabled.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: MANAGE_TOOL, arguments: {} },
    });
    assert.equal(denied.result.isError, true);
    assert.equal(runCalls.length, 0);

    const enabled = makeDispatcher({ executeEnabled: true });
    const ok = await enabled.dispatch({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: MANAGE_TOOL,
        arguments: { agentMode: "observe", nftTokenId: "1" },
      },
    });
    assert.equal(ok.result.isError, false);
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].config.agentMode, "execute");
    assert.equal(runCalls[0].config.nftTokenId, null);
  });

  it("rejects malformed JSON-RPC and unknown tools cleanly", async () => {
    const { dispatch } = makeDispatcher();
    const bad = await dispatch("not-an-object");
    assert.equal(bad.error.code, -32700);

    const unknownMethod = await dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    });
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await dispatch({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "swap", arguments: {} },
    });
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /unknown tool/i);
  });

  it("returns runOnce errors without secret leakage", async () => {
    const { dispatch } = makeDispatcher({
      runOnceFn: async () => {
        throw new Error("boom mcpk_live_test_secret_token and ai-secret-key");
      },
    });
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: ANALYZE_TOOL, arguments: {} },
    });
    assert.equal(res.result.isError, true);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.status, "error");
    assert.doesNotMatch(payload.error, /mcpk_live_test_secret_token/);
    assert.doesNotMatch(payload.error, /ai-secret-key/);
  });

  it("rejects same-agent concurrency and releases lock after failure", async () => {
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const { dispatch } = makeDispatcher({
      runOnceFn: async (deps) => {
        runCalls.push(deps);
        await gate;
        return { status: "ok", agentMode: deps.config.agentMode, results: [] };
      },
    });

    const firstPromise = dispatch({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: ANALYZE_TOOL, arguments: {} },
    });
    // Let the first call acquire the lock.
    await new Promise((r) => setTimeout(r, 10));

    const busy = await dispatch({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: ANALYZE_TOOL, arguments: {} },
    });
    assert.equal(busy.result.isError, true);
    const busyPayload = JSON.parse(busy.result.content[0].text);
    assert.equal(busyPayload.code, "LP_AGENT_BUSY");

    releaseGate();
    const first = await firstPromise;
    assert.equal(first.result.isError, false);

    const after = await dispatch({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: ANALYZE_TOOL, arguments: {} },
    });
    assert.equal(after.result.isError, false);
    assert.equal(runCalls.length, 2);
  });

  it("notifications/initialized returns null (HTTP 202)", async () => {
    const { dispatch } = makeDispatcher();
    const res = await dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(res, null);
  });
});
