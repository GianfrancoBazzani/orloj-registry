/**
 * End-to-end run-once pipeline (injected deps; no live network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runOnce } from "../src/run-once.mjs";
import {
  pairContextFromMarket,
  requirePairContextFromMarket,
} from "../src/decision-client.mjs";

const CONFIG = {
  orlojMcpUrl: "https://mcp.example/mcp",
  orlojMcpApiKey: "mcp_secret",
  theGraphApiKey: "graph_secret",
  subgraphId: "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
  graphUrl: "https://gateway.example/subgraphs/id/2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
  aiChatCompletionsUrl: "https://ai.example/v1/chat/completions",
  aiApiKey: "ai_secret",
  aiModel: "test-model",
  agentMode: "observe",
  nftTokenId: "7",
  chainId: "11155111",
};

const POSITION = {
  chainId: "11155111",
  walletAddress: "0x00000000000000000000000000000000000000aa",
  nftTokenId: "7",
  poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
  token0: "0x01",
  token1: "0x02",
  fee: "3000",
  tickLower: "0",
  tickUpper: "200",
  liquidity: "5000",
  tokensOwed0: "0",
  tokensOwed1: "0",
};

const MARKET = {
  poolId: "0xabcdef0123456789abcdef0123456789abcdef01",
  pool: {
    id: "0xabcdef0123456789abcdef0123456789abcdef01",
    feeTier: "3000",
    tick: "10",
    liquidity: "9000",
    token0: { id: "0x01", symbol: "AAA", decimals: "18", name: "A" },
    token1: { id: "0x02", symbol: "BBB", decimals: "6", name: "B" },
  },
  subgraphId: CONFIG.subgraphId,
  queriedAt: 1_700_000_000,
  meta: {
    blockNumber: "11348887",
    blockTimestamp: "1699999900",
    ageSeconds: 100,
    maxIndexedAgeSeconds: 3600,
  },
  hourData: [],
  swaps: [],
  windows: { swap: { truncated: false, complete: true, rowCount: 0 } },
};

const FEATURES = {
  position: {
    nftTokenId: "7",
    chainId: "11155111",
    poolAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    tickLower: 0,
    tickUpper: 200,
    positionLiquidity: "5000",
    fee: "3000",
    token0: "0x01",
    token1: "0x02",
  },
  range: {
    currentTick: 10,
    status: "in_range",
    inRange: true,
    width: 200,
    distanceToLower: 10,
    distanceToUpper: 190,
    nearestBoundary: "lower",
    nearestBoundaryDistance: 10,
    normalizedRangePosition: 0.05,
  },
  usdDataUsable: { usable: false, reasons: ["test"] },
  graph: {
    subgraphId: CONFIG.subgraphId,
    indexedBlock: "11348887",
    ageSeconds: 100,
  },
  missingInputFlags: ["usd_data_unusable"],
};

function holdDecision() {
  return {
    action: "HOLD",
    confidence: 0.6,
    liquidityPercentageToDecrease: null,
    summary: "hold",
    signals: [
      {
        direction: "SUPPORTS_HOLD",
        observation: "in range",
        citations: ["range.status"],
      },
    ],
    uncertainties: [],
    graphEvidence: {
      subgraphId: CONFIG.subgraphId,
      indexedBlock: "11348887",
      ageSeconds: 100,
      citedFeaturePaths: ["range.status"],
    },
  };
}

function reduceDecision() {
  return {
    action: "REDUCE_LIQUIDITY",
    confidence: 0.8,
    liquidityPercentageToDecrease: 40,
    summary: "reduce",
    signals: [
      {
        direction: "SUPPORTS_REDUCE",
        observation: "near boundary",
        citations: ["range.nearestBoundaryDistance"],
      },
      {
        direction: "SUPPORTS_REDUCE",
        observation: "liq trend",
        citations: ["liquidity.trend_24h.value"],
      },
    ],
    uncertainties: [],
    graphEvidence: {
      subgraphId: CONFIG.subgraphId,
      indexedBlock: "11348887",
      ageSeconds: 100,
      citedFeaturePaths: [
        "range.nearestBoundaryDistance",
        "liquidity.trend_24h.value",
      ],
    },
  };
}

describe("run-once pipeline", () => {
  it("requirePairContextFromMarket fails closed on null", () => {
    assert.throws(
      () => requirePairContextFromMarket(null, MARKET),
      /address-only fallback is forbidden/,
    );
    const pair = pairContextFromMarket(MARKET);
    assert.ok(pair);
    assert.equal(requirePairContextFromMarket(pair).feeTier, "3000");
  });

  it("observe HOLD: validates pair before AI, produces no write plan", async () => {
    let validatedPairBeforeAi = false;
    let aiSawPair = false;

    const trace = await runOnce({
      config: CONFIG,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      pairFromMarketFn: pairContextFromMarket,
      requestDecisionFn: async (_client, input) => {
        assert.ok(input.pair);
        assert.equal(input.pair.feeTier, "3000");
        assert.equal(input.pair.token0.symbol, "AAA");
        aiSawPair = true;
        validatedPairBeforeAi = true;
        return holdDecision();
      },
    });

    assert.equal(validatedPairBeforeAi, true);
    assert.equal(aiSawPair, true);
    assert.equal(trace.plan.kind, "no_write");
    assert.equal(trace.plan.mcpCall, null);
    assert.equal(trace.execution.status, "observe");
    assert.equal(trace.decision.action, "HOLD");
  });

  it("observe REDUCE: plans decrease_v3_position only with NFT + percentage", async () => {
    const trace = await runOnce({
      config: CONFIG,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => ({
        ...FEATURES,
        liquidity: { trend_24h: { value: -0.2 }, poolLiquidity: "9000" },
      }),
      requestDecisionFn: async () => reduceDecision(),
    });

    assert.equal(trace.plan.kind, "proposed_write");
    assert.equal(trace.plan.mcpCall.toolName, "decrease_v3_position");
    assert.deepEqual(trace.plan.mcpCall.arguments, {
      chainId: "11155111",
      nftTokenId: "7",
      liquidityPercentageToDecrease: 40,
    });
    assert.equal(trace.execution.proposedCall.toolName, "decrease_v3_position");
  });

  it("execute mode HOLD reports held/no_write and never calls MCP write", async () => {
    let decreaseCalls = 0;
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => holdDecision(),
      decreasePosition: async () => {
        decreaseCalls += 1;
        throw new Error("should not decrease on HOLD");
      },
    });
    assert.equal(trace.phase, 2);
    assert.equal(trace.execution.status, "held");
    assert.equal(trace.execution.kind, "no_write");
    assert.equal(trace.execution.called, null);
    assert.equal(trace.execution.mcpResponse, null);
    assert.notEqual(trace.execution.status, "pending");
    assert.equal(decreaseCalls, 0);
    assert.match(trace.execution.message, /nothing executed/i);
  });

  it("execute mode REDUCE calls decrease_v3_position exactly once with plan args", async () => {
    const calls = [];
    const mcpPayload = { txHash: "0xabc", amount0: "1", amount1: "2" };
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => reduceDecision(),
      decreasePosition: async (_client, params) => {
        calls.push(params);
        return mcpPayload;
      },
    });
    assert.equal(trace.phase, 2);
    assert.equal(trace.execution.status, "executed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      chainId: "11155111",
      nftTokenId: "7",
      liquidityPercentageToDecrease: 40,
    });
    assert.deepEqual(trace.execution.called, {
      toolName: "decrease_v3_position",
      arguments: {
        chainId: "11155111",
        nftTokenId: "7",
        liquidityPercentageToDecrease: 40,
      },
    });
    assert.deepEqual(trace.execution.mcpResponse, mcpPayload);
  });

  it("execute mode surfaces MCP failure with full audit-complete trace", async () => {
    await assert.rejects(
      () =>
        runOnce({
          config: { ...CONFIG, agentMode: "execute" },
          getPosition: async () => POSITION,
          fetchMarket: async () => MARKET,
          extractFeaturesFn: () => FEATURES,
          requestDecisionFn: async () => reduceDecision(),
          decreasePosition: async () => {
            throw new Error("MCP tool error: insufficient liquidity");
          },
        }),
      (err) => {
        assert.match(String(err.message), /execute decrease_v3_position failed/);
        assert.match(String(err.message), /insufficient liquidity/);
        const trace = /** @type {any} */ (err).auditTrace;
        assert.ok(trace, "auditTrace must be attached");
        assert.equal(trace.status, "error");
        assert.equal(trace.phase, 2);
        assert.equal(trace.agentMode, "execute");
        assert.equal(trace.position.nftTokenId, "7");
        assert.equal(trace.graph.subgraphId, CONFIG.subgraphId);
        assert.equal(trace.decision.action, "REDUCE_LIQUIDITY");
        assert.equal(trace.plan.mcpCall.toolName, "decrease_v3_position");
        assert.equal(trace.execution.status, "failed");
        assert.equal(trace.execution.mode, "execute");
        assert.match(trace.execution.error, /insufficient liquidity/);
        assert.notEqual(trace.execution.status, "observe");
        return true;
      },
    );
  });

  it("observe mode REDUCE never calls decreasePosition", async () => {
    let decreaseCalls = 0;
    const trace = await runOnce({
      config: CONFIG,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => reduceDecision(),
      decreasePosition: async () => {
        decreaseCalls += 1;
        return {};
      },
    });
    assert.equal(trace.phase, 1);
    assert.equal(trace.execution.status, "observe");
    assert.equal(decreaseCalls, 0);
  });

  it("fails closed when pairContextFromMarket is null", async () => {
    await assert.rejects(
      () =>
        runOnce({
          config: CONFIG,
          getPosition: async () => POSITION,
          fetchMarket: async () => MARKET,
          extractFeaturesFn: () => FEATURES,
          pairFromMarketFn: () => null,
          requestDecisionFn: async () => {
            throw new Error("AI must not be called");
          },
        }),
      /pairContextFromMarket returned null|address-only fallback is forbidden/,
    );
  });

  it("fails closed when fee tier missing from market pair", async () => {
    const marketNoFee = {
      ...MARKET,
      pool: { ...MARKET.pool, feeTier: undefined },
    };
    await assert.rejects(
      () =>
        runOnce({
          config: CONFIG,
          getPosition: async () => POSITION,
          fetchMarket: async () => marketNoFee,
          extractFeaturesFn: () => FEATURES,
          requestDecisionFn: async () => {
            throw new Error("AI must not be called");
          },
        }),
      /pairContextFromMarket returned null|fee/,
    );
  });

  it("fails closed when pair token ids disagree with features.position", async () => {
    await assert.rejects(
      () =>
        runOnce({
          config: CONFIG,
          getPosition: async () => POSITION,
          fetchMarket: async () => MARKET,
          extractFeaturesFn: () => ({
            ...FEATURES,
            position: { ...FEATURES.position, token0: "0x99" },
          }),
          requestDecisionFn: async () => {
            throw new Error("AI must not be called");
          },
        }),
      /token ids do not match/,
    );
  });
});
