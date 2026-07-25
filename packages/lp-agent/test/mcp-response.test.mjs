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
  validateGetV3Position,
  redactSecrets,
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

const ADDR = {
  wallet: "0x1111111111111111111111111111111111111111",
  pool: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
  token0: "0x0000000000000000000000000000000000000001",
  token1: "0x0000000000000000000000000000000000000002",
};

/** @returns {Record<string, unknown>} */
function validPosition(overrides = {}) {
  return {
    chainId: 11155111,
    walletAddress: ADDR.wallet,
    nftTokenId: "7",
    poolAddress: ADDR.pool,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: "3000",
    tickLower: "-120",
    tickUpper: "120",
    liquidity: "1000",
    tokensOwed0: "1",
    tokensOwed1: "2",
    ...overrides,
  };
}

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

  it("requires CHAIN_ID to be exactly Sepolia 11155111", () => {
    assert.throws(
      () => loadConfig({ ...validEnv, CHAIN_ID: "1" }),
      /11155111/,
    );
    assert.throws(
      () => loadConfig({ ...validEnv, CHAIN_ID: "17000" }),
      /11155111/,
    );
    assert.throws(
      () => loadConfig({ ...validEnv, CHAIN_ID: "sepolia" }),
      /11155111/,
    );
    assert.throws(
      () => loadConfig({ ...validEnv, CHAIN_ID: "011155111" }),
      /11155111/,
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
    const position = validPosition({ nftTokenId: "42" });
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

  it("strictly validates get_v3_position payloads", () => {
    const request = { chainId: "11155111", nftTokenId: "7" };
    const ok = validateGetV3Position(validPosition(), request);
    assert.equal(ok.chainId, "11155111");
    assert.equal(ok.nftTokenId, "7");
    assert.equal(ok.poolAddress, ADDR.pool);

    assert.throws(() => validateGetV3Position(null, request), /non-null/);
    assert.throws(() => validateGetV3Position([], request), /non-null/);
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ poolAddress: undefined }), request),
      /missing required field: poolAddress/,
    );
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ poolAddress: "0xabc" }), request),
      /poolAddress/,
    );
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ fee: "03000" }), request),
      /fee/,
    );
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ chainId: 1 }), request),
      /chainId/,
    );
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ nftTokenId: "8" }), request),
      /does not match request/,
    );
    assert.throws(
      () =>
        validateGetV3Position(validPosition({ tickLower: "-012" }), request),
      /tickLower/,
    );
  });

  it("accepts numeric or string Sepolia chainId from get_v3_position", () => {
    const request = { chainId: "11155111", nftTokenId: "7" };
    const fromNumber = validateGetV3Position(
      validPosition({ chainId: 11155111 }),
      request,
    );
    const fromString = validateGetV3Position(
      validPosition({ chainId: "11155111" }),
      request,
    );
    assert.equal(fromNumber.chainId, "11155111");
    assert.equal(fromString.chainId, "11155111");
  });

  it("callMcpTool posts Bearer auth and validates get_v3_position JSON", async () => {
    /** @type {RequestInit | undefined} */
    let seenInit;
    /** @type {string | undefined} */
    let seenUrl;

    const fetchImpl = async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify(validPosition()) },
            ],
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
    assert.equal(toSubgraphPoolId(data.poolAddress), ADDR.pool.toLowerCase());
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
    assert.doesNotMatch(message, /Bearer very-secret/);
  });

  it("redacts MCP API key when an upstream HTTP body echoes it", async () => {
    const apiKey = "mcpk_live_echo_secret_value";
    const fetchImpl = async () =>
      new Response(
        `unauthorized token=${apiKey} Authorization: Bearer ${apiKey}`,
        { status: 401 },
      );

    let message = "";
    try {
      await callMcpTool(
        { url: "http://mcp.test/mcp", apiKey, fetchImpl },
        "get_v3_position",
        { chainId: "11155111", nftTokenId: "1" },
      );
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.match(message, /MCP HTTP 401/);
    assert.doesNotMatch(message, new RegExp(apiKey));
    assert.match(message, /\[REDACTED\]/);
    assert.equal(redactSecrets(`Bearer ${apiKey}`, apiKey), "Bearer [REDACTED]");
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

  it("fail closed: timeout during fetch", async () => {
    await assert.rejects(
      () =>
        callMcpTool(
          {
            url: "http://mcp.test/mcp",
            apiKey: "mcp_timeout_key",
            timeoutMs: 20,
            fetchImpl: async (_url, init) => {
              await new Promise((_, reject) => {
                init.signal.addEventListener("abort", () => {
                  const err = new Error("The operation was aborted");
                  err.name = "AbortError";
                  reject(err);
                });
              });
            },
          },
          "get_v3_position",
          { chainId: "11155111", nftTokenId: "1" },
        ),
      /MCP request timed out after 20ms/,
    );
  });

  it("fail closed: timeout remains active through body read", async () => {
    await assert.rejects(
      () =>
        callMcpTool(
          {
            url: "http://mcp.test/mcp",
            apiKey: "mcp_body_timeout_key",
            timeoutMs: 25,
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                return "{}";
              },
            }),
          },
          "get_v3_position",
          { chainId: "11155111", nftTokenId: "1" },
        ),
      /MCP request timed out after 25ms/,
    );
  });

  it("fail closed: body-read errors are redacted", async () => {
    const apiKey = "mcp_body_read_secret_xyz";
    await assert.rejects(
      () =>
        callMcpTool(
          {
            url: "http://mcp.test/mcp",
            apiKey,
            timeoutMs: 5_000,
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => {
                throw new Error(`socket fail Bearer ${apiKey}`);
              },
            }),
          },
          "get_v3_position",
          { chainId: "11155111", nftTokenId: "1" },
        ),
      (err) => {
        assert.match(String(err.message), /MCP HTTP body read failed/);
        assert.equal(String(err.message).includes(apiKey), false);
        return true;
      },
    );
  });

  it("rejects invalid timeoutMs", async () => {
    await assert.rejects(
      () =>
        callMcpTool(
          {
            url: "http://mcp.test/mcp",
            apiKey: "k",
            timeoutMs: 0,
            fetchImpl: async () => {
              throw new Error("should not fetch");
            },
          },
          "get_v3_position",
          { chainId: "11155111", nftTokenId: "1" },
        ),
      /timeoutMs must be a positive finite number/,
    );
    await assert.rejects(
      () =>
        callMcpTool(
          {
            url: "http://mcp.test/mcp",
            apiKey: "k",
            timeoutMs: -5,
            fetchImpl: async () => {
              throw new Error("should not fetch");
            },
          },
          "get_v3_position",
          { chainId: "11155111", nftTokenId: "1" },
        ),
      /timeoutMs must be a positive finite number/,
    );
  });
});
