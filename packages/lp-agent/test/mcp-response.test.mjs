import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadConfig,
  toSubgraphPoolId,
  DEFAULT_SUBGRAPH_ID,
  DEFAULT_CHAIN_ID,
} from "../src/config.mjs";
import {
  buildToolsCallRequest,
  parseMcpToolsCallResponse,
  callMcpTool,
  getV3Position,
  claimV3Fees,
  decreaseV3Position,
} from "../src/orloj-mcp-client.mjs";

const validEnv = {
  ORLOJ_MCP_URL: "http://127.0.0.1:3001/interface/uniswap/mcp",
  ORLOJ_MCP_API_KEY: "mcpk_live_test_secret",
  THE_GRAPH_API_KEY: "graph_test_secret",
  AI_CHAT_COMPLETIONS_URL: "https://example.com/v1/chat/completions",
  AI_API_KEY: "ai_test_secret",
  AI_MODEL: "test-model",
  NFT_TOKEN_ID: "12345",
  AGENT_MODE: "observe",
  CHAIN_ID: "11155111",
};

describe("config", () => {
  it("loads a complete env and builds the Graph gateway URL", () => {
    const cfg = loadConfig(validEnv);
    assert.equal(cfg.chainId, DEFAULT_CHAIN_ID);
    assert.equal(cfg.subgraphId, DEFAULT_SUBGRAPH_ID);
    assert.equal(
      cfg.graphUrl,
      `https://gateway.thegraph.com/api/subgraphs/id/${DEFAULT_SUBGRAPH_ID}`,
    );
    assert.equal(cfg.agentMode, "observe");
    assert.equal(cfg.nftTokenId, "12345");
  });

  it("lists missing keys and does not include secret values in the message", () => {
    let message = "";
    try {
      loadConfig({
        ORLOJ_MCP_URL: "http://example",
        ORLOJ_MCP_API_KEY: "super-secret-key",
        AGENT_MODE: "observe",
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.match(message, /Missing required environment variables/);
    assert.match(message, /THE_GRAPH_API_KEY/);
    assert.match(message, /NFT_TOKEN_ID/);
    assert.doesNotMatch(message, /super-secret-key/);
  });

  it("rejects invalid AGENT_MODE", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, AGENT_MODE: "dry-run" }),
      /AGENT_MODE/,
    );
  });

  it("normalizes checksummed pool addresses for subgraph IDs", () => {
    assert.equal(
      toSubgraphPoolId("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"),
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    assert.throws(() => toSubgraphPoolId(""), /non-empty/);
  });
});

describe("mcp-response", () => {
  it("builds a tools/call JSON-RPC request without secrets", () => {
    const body = buildToolsCallRequest("get_v3_position", {
      chainId: "11155111",
      nftTokenId: "99",
    });
    assert.deepEqual(body, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_v3_position",
        arguments: { chainId: "11155111", nftTokenId: "99" },
      },
    });
  });

  it("parses a successful get_v3_position tools/call result", () => {
    const position = {
      chainId: 11155111,
      walletAddress: "0xWallet",
      nftTokenId: "42",
      poolAddress: "0xPoolCheckSum",
      token0: "0xToken0",
      token1: "0xToken1",
      fee: "3000",
      tickLower: "-120",
      tickUpper: "120",
      liquidity: "1000",
      tokensOwed0: "1",
      tokensOwed1: "2",
    };
    const parsed = parseMcpToolsCallResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(position) }],
        isError: false,
      },
    });
    assert.equal(parsed.isError, false);
    assert.deepEqual(parsed.data, position);
  });

  it("surfaces MCP tool isError text without treating it as success", () => {
    assert.throws(
      () =>
        parseMcpToolsCallResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "stage=position read: not owner" }],
            isError: true,
          },
        }),
      /MCP tool error: stage=position read: not owner/,
    );
  });

  it("surfaces JSON-RPC errors", () => {
    assert.throws(
      () =>
        parseMcpToolsCallResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "method not found: foo" },
        }),
      /JSON-RPC error code=-32601/,
    );
  });

  it("rejects missing content", () => {
    assert.throws(
      () =>
        parseMcpToolsCallResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: false, content: [] },
        }),
      /content must be a non-empty array/,
    );
  });

  it("callMcpTool posts Bearer auth and parses JSON via injected fetch", async () => {
    /** @type {RequestInit | undefined} */
    let seenInit;
    /** @type {string | undefined} */
    let seenUrl;

    const fetchImpl = async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      const position = {
        poolAddress: "0xAbC",
        nftTokenId: "7",
        tickLower: "0",
        tickUpper: "10",
        liquidity: "1",
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify(position) }],
            isError: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const data = await getV3Position(
      {
        url: "http://mcp.test/interface/uniswap/mcp",
        apiKey: "secret-token-should-not-leak",
        fetchImpl,
      },
      { chainId: "11155111", nftTokenId: "7" },
    );

    assert.equal(seenUrl, "http://mcp.test/interface/uniswap/mcp");
    assert.equal(seenInit?.method, "POST");
    const headers = /** @type {Record<string, string>} */ (seenInit?.headers);
    assert.equal(headers.authorization, "Bearer secret-token-should-not-leak");
    assert.equal(data.nftTokenId, "7");
    assert.equal(toSubgraphPoolId(/** @type {string} */ (data.poolAddress)), "0xabc");
  });

  it("callMcpTool HTTP errors do not embed the API key", async () => {
    const fetchImpl = async () =>
      new Response("upstream boom", { status: 401 });

    let message = "";
    try {
      await callMcpTool(
        {
          url: "http://mcp.test/mcp",
          apiKey: "very-secret-api-key",
          fetchImpl,
        },
        "get_v3_position",
        { chainId: "11155111", nftTokenId: "1" },
      );
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.match(message, /MCP HTTP 401/);
    assert.doesNotMatch(message, /very-secret-api-key/);
    assert.doesNotMatch(message, /Bearer/);
  });

  it("exposes claim and decrease helpers for later use", async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            isError: false,
          },
        }),
        { status: 200 },
      );
    };
    const client = {
      url: "http://mcp.test/mcp",
      apiKey: "k",
      fetchImpl,
    };

    await claimV3Fees(client, { chainId: "11155111", nftTokenId: "1" });
    await decreaseV3Position(client, {
      chainId: "11155111",
      nftTokenId: "1",
      liquidityPercentageToDecrease: 25,
    });

    assert.equal(calls[0].params.name, "claim_v3_fees");
    assert.equal(calls[1].params.name, "decrease_v3_position");
    assert.equal(calls[1].params.arguments.liquidityPercentageToDecrease, 25);
  });
});
