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
import { emptyState } from "../src/state-store.mjs";

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
  stateFilePath: "/tmp/lp-agent-test-state.json",
  allowCreateRetry: false,
  allowCreateRetryCycleId: null,
};

const POSITION = {
  chainId: "11155111",
  walletAddress: "0x00000000000000000000000000000000000000aa",
  nftTokenId: "7",
  poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
  token0: "0x0000000000000000000000000000000000000001",
  token1: "0x0000000000000000000000000000000000000002",
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
    token0: {
      id: "0x0000000000000000000000000000000000000001",
      symbol: "AAA",
      decimals: "18",
      name: "A",
    },
    token1: {
      id: "0x0000000000000000000000000000000000000002",
      symbol: "BBB",
      decimals: "6",
      name: "B",
    },
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
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
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
  liquidity: { trend_24h: { value: -0.2 }, poolLiquidity: "9000" },
};

function holdDecision() {
  return {
    action: "HOLD",
    confidence: 0.6,
    liquidityPercentageToDecrease: null,
    rangeWidthBps: null,
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
    rangeWidthBps: null,
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

function rebalanceDecision() {
  return {
    action: "REBALANCE",
    confidence: 0.85,
    liquidityPercentageToDecrease: 100,
    rangeWidthBps: 800,
    summary: "rebalance",
    signals: [
      {
        direction: "SUPPORTS_REBALANCE",
        observation: "out of useful range proximity",
        citations: ["range.nearestBoundaryDistance"],
      },
      {
        direction: "SUPPORTS_REBALANCE",
        observation: "liquidity trend down",
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

function memoryStateStore() {
  let state = emptyState();
  return {
    loadStateFn: () => structuredClone(state),
    saveStateFn: (_path, next) => {
      state = structuredClone(next);
    },
    getState: () => state,
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

    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
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
    assert.equal(trace.discovery.source, "env_filter");
    assert.equal(trace.results.length, 1);
    const r = trace.results[0];
    assert.equal(r.plan.kind, "no_write");
    assert.equal(r.plan.mcpCall, null);
    assert.equal(r.execution.status, "observe");
    assert.equal(r.decision.action, "HOLD");
    assert.equal(r.nftResolution.source, "env_filter");
  });

  it("observe REDUCE: plans decrease_v3_position only with NFT + percentage", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => reduceDecision(),
    });

    const r = trace.results[0];
    assert.equal(r.plan.kind, "proposed_write");
    assert.equal(r.plan.mcpCall.toolName, "decrease_v3_position");
    assert.deepEqual(r.plan.mcpCall.arguments, {
      chainId: "11155111",
      nftTokenId: "7",
      liquidityPercentageToDecrease: 40,
    });
    assert.equal(r.execution.proposedCall.toolName, "decrease_v3_position");
  });

  it("observe REBALANCE proposes decrease+create only", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => rebalanceDecision(),
    });
    const r = trace.results[0];
    assert.equal(r.plan.kind, "rebalance");
    assert.equal(r.plan.steps.length, 3);
    assert.equal(r.plan.steps[0].toolName, "decrease_v3_position");
    assert.equal(r.plan.steps[1].toolName, "swap");
    assert.equal(r.plan.steps[2].toolName, "create_v3_position");
    assert.equal(r.plan.steps[2].arguments.poolAddress, POSITION.poolAddress);
    assert.equal(r.plan.steps[2].arguments.tokenA, POSITION.token0);
    assert.equal(r.plan.steps[2].arguments.maxTokenAAmount, null);
    assert.equal(r.execution.status, "observe");
    assert.equal(r.execution.proposedSteps.length, 3);
  });

  it("execute mode HOLD reports held/no_write and never calls MCP write", async () => {
    let decreaseCalls = 0;
    const store = memoryStateStore();
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => holdDecision(),
      decreasePosition: async () => {
        decreaseCalls += 1;
        throw new Error("should not decrease on HOLD");
      },
    });
    const r = trace.results[0];
    assert.equal(trace.phase, 2);
    assert.equal(r.execution.status, "held");
    assert.equal(r.execution.kind, "no_write");
    assert.equal(r.execution.called, null);
    assert.equal(r.execution.mcpResponse, null);
    assert.notEqual(r.execution.status, "pending");
    assert.equal(decreaseCalls, 0);
    assert.match(r.execution.message, /nothing executed/i);
  });

  it("execute mode REDUCE calls decrease_v3_position exactly once with plan args", async () => {
    const calls = [];
    const mcpPayload = { txHash: "0xabc", amount0: "1", amount1: "2" };
    const store = memoryStateStore();
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => reduceDecision(),
      decreasePosition: async (_client, params) => {
        calls.push(params);
        return mcpPayload;
      },
    });
    const r = trace.results[0];
    assert.equal(trace.phase, 2);
    assert.equal(r.execution.status, "executed");
    assert.deepEqual(r.features, FEATURES);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      chainId: "11155111",
      nftTokenId: "7",
      liquidityPercentageToDecrease: 40,
    });
    assert.deepEqual(r.execution.called, {
      toolName: "decrease_v3_position",
      arguments: {
        chainId: "11155111",
        nftTokenId: "7",
        liquidityPercentageToDecrease: 40,
      },
    });
    assert.deepEqual(r.execution.mcpResponse, mcpPayload);
  });

  it("execute mode surfaces MCP failure with full audit-complete per-position result", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => reduceDecision(),
      decreasePosition: async () => {
        throw new Error("MCP tool error: insufficient liquidity");
      },
    });
    assert.equal(trace.status, "error");
    assert.equal(trace.results.length, 1);
    const r = trace.results[0];
    assert.equal(r.status, "error");
    assert.equal(r.phase, 2);
    assert.equal(r.agentMode, "execute");
    assert.equal(r.position.nftTokenId, "7");
    assert.equal(r.graph.subgraphId, CONFIG.subgraphId);
    assert.deepEqual(r.features, FEATURES);
    assert.equal(r.decision.action, "REDUCE_LIQUIDITY");
    assert.equal(r.plan.mcpCall.toolName, "decrease_v3_position");
    assert.equal(r.execution.status, "failed");
    assert.equal(r.execution.mode, "execute");
    assert.match(r.execution.error, /insufficient liquidity/);
    assert.notEqual(r.execution.status, "observe");
  });

  it("observe mode REDUCE never calls decreasePosition", async () => {
    let decreaseCalls = 0;
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
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
    assert.equal(trace.results[0].execution.status, "observe");
    assert.equal(decreaseCalls, 0);
  });

  it("fails closed when pairContextFromMarket is null (per-position error preserved)", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      pairFromMarketFn: () => null,
      requestDecisionFn: async () => {
        throw new Error("AI must not be called");
      },
    });
    assert.equal(trace.status, "error");
    assert.match(
      String(trace.results[0].error),
      /pairContextFromMarket returned null|address-only fallback is forbidden/,
    );
  });

  it("fails closed when fee tier missing from market pair", async () => {
    const marketNoFee = {
      ...MARKET,
      pool: { ...MARKET.pool, feeTier: undefined },
    };
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => marketNoFee,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => {
        throw new Error("AI must not be called");
      },
    });
    assert.equal(trace.status, "error");
    assert.match(String(trace.results[0].error), /pairContextFromMarket returned null|fee/);
  });

  it("fails closed when pair token ids disagree with features.position", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: CONFIG,
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => ({
        ...FEATURES,
        position: {
          ...FEATURES.position,
          token0: "0x0000000000000000000000000000000000000099",
        },
      }),
      requestDecisionFn: async () => {
        throw new Error("AI must not be called");
      },
    });
    assert.equal(trace.status, "error");
    assert.match(String(trace.results[0].error), /token ids do not match/);
  });

  it("discovers all positions when NFT unset and truncated=false", async () => {
    const store = memoryStateStore();
    const decisions = { "7": holdDecision(), "8": holdDecision() };
    const trace = await runOnce({
      config: { ...CONFIG, nftTokenId: null },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 2,
        totalOwned: 2,
        nftTokenIds: ["7", "8"],
        positions: [{ nftTokenId: "7" }, { nftTokenId: "8" }],
      }),
      getPosition: async (_c, { nftTokenId }) => ({
        ...POSITION,
        nftTokenId,
      }),
      fetchMarket: async () => MARKET,
      extractFeaturesFn: (pos) => ({
        ...FEATURES,
        position: { ...FEATURES.position, nftTokenId: pos.nftTokenId },
      }),
      requestDecisionFn: async (_c, input) =>
        decisions[input.features.position.nftTokenId] ?? holdDecision(),
    });
    assert.equal(trace.discovery.source, "list_v3_positions");
    assert.equal(trace.discovery.truncated, false);
    assert.equal(trace.results.length, 2);
    assert.deepEqual(
      trace.results.map((r) => r.nftResolution.nftTokenId),
      ["7", "8"],
    );
  });

  it("one failed position does not hide other results in observe", async () => {
    const store = memoryStateStore();
    let n = 0;
    const trace = await runOnce({
      config: { ...CONFIG, nftTokenId: null },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 2,
        totalOwned: 2,
        nftTokenIds: ["7", "8"],
        positions: [{ nftTokenId: "7" }, { nftTokenId: "8" }],
      }),
      getPosition: async (_c, { nftTokenId }) => {
        n += 1;
        if (nftTokenId === "7") throw new Error("boom on first");
        return { ...POSITION, nftTokenId };
      },
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => holdDecision(),
    });
    assert.equal(trace.status, "partial");
    assert.equal(trace.results.length, 2);
    assert.equal(trace.results[0].status, "error");
    assert.match(String(trace.results[0].error), /boom on first/);
    assert.equal(trace.results[1].status, "ok");
    assert.equal(trace.results[1].decision.action, "HOLD");
    assert.equal(n, 2);
  });

  it("execute REBALANCE does not auto-remint after create failure; recovery before discovery", async () => {
    const store = memoryStateStore();
    const decreaseCalls = [];
    const createCalls = [];

    const decreaseResp = {
      hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nftTokenId: "7",
      liquidityPercentageToDecrease: 100,
      token0: {
        tokenAddress: POSITION.token0,
        amount: "1000000000000000000",
      },
      token1: { tokenAddress: POSITION.token1, amount: "2000000" },
    };

    // First run: create fails after decrease.
    const first = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => rebalanceDecision(),
      decreasePosition: async (_c, params) => {
        decreaseCalls.push(params);
        return decreaseResp;
      },
      createPosition: async () => {
        throw new Error("create blew up");
      },
      listPositions: async () => ({
        truncated: false,
        positions: [
          {
            nftTokenId: "7",
            poolAddress: POSITION.poolAddress,
            liquidity: "5000",
          },
        ],
      }),
    });
    assert.equal(first.status, "error");
    assert.equal(decreaseCalls.length, 1);
    assert.equal(store.getState().inProgress["7"].decrease.status, "succeeded");
    assert.ok(store.getState().inProgress["7"].decrease.budgets);
    assert.deepEqual(store.getState().inProgress["7"].ownedNftIdsBaseline, ["7"]);

    // Second run: NFT filtered out of discovery (zero liquidity) — recovery must still run.
    // Must NOT decrease again; must NOT auto-create without allowCreateRetry.
    const second = await runOnce({
      config: { ...CONFIG, agentMode: "execute", nftTokenId: null },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 0,
        totalOwned: 1,
        nftTokenIds: [],
        positions: [], // zero-liquidity NFT omitted
      }),
      getPosition: async () => {
        throw new Error("should not get_position for AI path");
      },
      requestDecisionFn: async () => {
        throw new Error("AI must not run for recovery");
      },
      decreasePosition: async (_c, params) => {
        decreaseCalls.push(params);
        throw new Error("must not decrease again");
      },
      createPosition: async (_c, params) => {
        createCalls.push(params);
        throw new Error("must not auto create");
      },
      listPositions: async () => ({
        truncated: false,
        positions: [],
      }),
    });
    assert.equal(second.status, "error");
    assert.equal(decreaseCalls.length, 1);
    assert.equal(createCalls.length, 0);
    assert.equal(second.results[0].status, "needs_attention");
    assert.equal(second.results[0].execution.status, "needs_reconciliation");
    assert.equal(second.discovery.skippedForRecovery.includes("7"), true);
    assert.ok(store.getState().inProgress["7"]);
  });

  it("operator-approved create retry after decrease (LP_AGENT_ALLOW_CREATE_RETRY)", async () => {
    const store = memoryStateStore();
    const HASH =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    store.saveStateFn("/tmp/x", {
      version: 1,
      inProgress: {
        "7": {
          cycleId: "c1",
          oldNftTokenId: "7",
          poolAddress: POSITION.poolAddress,
          token0: POSITION.token0,
          token1: POSITION.token1,
          liquidityPercentageToDecrease: 100,
          rangeWidthBps: 800,
          ownedNftIdsBaseline: ["7"],
          createRetryAttempted: false,
          decrease: {
            status: "succeeded",
            hash: HASH,
            budgets: {
              tokenA: POSITION.token0,
              tokenB: POSITION.token1,
              maxTokenAAmount: "1",
              maxTokenBAmount: "2",
            },
            mcpResponse: { hash: HASH },
          },
          swap: { status: "skipped" },
          create: { status: "failed", error: "prior" },
          newNftTokenId: null,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const createCalls = [];
    const trace = await runOnce({
      config: {
        ...CONFIG,
        agentMode: "execute",
        nftTokenId: null,
        allowCreateRetry: true,
        allowCreateRetryCycleId: "c1",
      },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 0,
        totalOwned: 0,
        nftTokenIds: [],
        positions: [],
      }),
      listPositions: async () => ({ truncated: false, positions: [] }),
      getPosition: async () => POSITION,
      requestDecisionFn: async () => {
        throw new Error("no AI");
      },
      decreasePosition: async () => {
        throw new Error("no decrease");
      },
      createPosition: async (_c, params) => {
        createCalls.push(params);
        return {
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          nftTokenId: "99",
        };
      },
    });
    assert.equal(createCalls.length, 1);
    assert.equal(trace.status, "ok");
    assert.equal(trace.results[0].execution.newNftTokenId, "99");
    assert.equal(store.getState().inProgress["7"], undefined);
  });

  it("create retry is one-shot even if ALLOW_CREATE_RETRY stays true", async () => {
    const store = memoryStateStore();
    const HASH =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    store.saveStateFn("/tmp/x", {
      version: 1,
      inProgress: {
        "7": {
          cycleId: "c1",
          oldNftTokenId: "7",
          poolAddress: POSITION.poolAddress,
          token0: POSITION.token0,
          token1: POSITION.token1,
          liquidityPercentageToDecrease: 100,
          rangeWidthBps: 800,
          ownedNftIdsBaseline: ["7"],
          createRetryAttempted: true,
          decrease: {
            status: "succeeded",
            hash: HASH,
            budgets: {
              tokenA: POSITION.token0,
              tokenB: POSITION.token1,
              maxTokenAAmount: "1",
              maxTokenBAmount: "2",
            },
          },
          swap: { status: "skipped" },
          create: { status: "failed", error: "prior" },
          newNftTokenId: null,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    let creates = 0;
    const trace = await runOnce({
      config: {
        ...CONFIG,
        agentMode: "execute",
        nftTokenId: null,
        allowCreateRetry: true,
      },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 0,
        totalOwned: 0,
        nftTokenIds: [],
        positions: [],
      }),
      listPositions: async () => ({ truncated: false, positions: [] }),
      getPosition: async () => POSITION,
      createPosition: async () => {
        creates += 1;
        return {
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          nftTokenId: "99",
        };
      },
    });
    assert.equal(creates, 0);
    assert.match(String(trace.results[0].execution.message), /already attempted/);
  });

  it("empty active discovery after recovery preserves recovery results", async () => {
    const store = memoryStateStore();
    store.saveStateFn("/tmp/x", {
      version: 1,
      inProgress: {
        "7": {
          cycleId: "c1",
          oldNftTokenId: "7",
          poolAddress: POSITION.poolAddress,
          token0: POSITION.token0,
          token1: POSITION.token1,
          liquidityPercentageToDecrease: 100,
          rangeWidthBps: 800,
          ownedNftIdsBaseline: ["7"],
          createRetryAttempted: false,
          decrease: { status: "pending", budgets: null },
          create: { status: "pending" },
          newNftTokenId: null,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const { discoverManagedPositions } = await import("../src/discovery.mjs");
    const listPositions = async () => ({
      truncated: false,
      count: 1,
      totalOwned: 1,
      positions: [
        {
          nftTokenId: "7",
          poolAddress: POSITION.poolAddress,
          liquidity: "0",
        },
      ],
    });
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute", nftTokenId: null },
      ...store,
      discoverFn: (client, cfg) =>
        discoverManagedPositions(client, cfg, { listPositions }),
      listPositions,
      decreasePosition: async () => {
        throw new Error("no decrease");
      },
    });
    assert.equal(trace.results.length, 1);
    assert.equal(trace.results[0].execution.status, "needs_reconciliation");
    assert.equal(trace.discovery.count, 0);
    assert.deepEqual(trace.discovery.nftTokenIds, []);
    assert.equal(trace.status, "error");
  });

  it("nonterminal decrease status never repeats withdrawal", async () => {
    const store = memoryStateStore();
    store.saveStateFn("/tmp/x", {
      version: 1,
      inProgress: {
        "7": {
          cycleId: "c1",
          oldNftTokenId: "7",
          poolAddress: POSITION.poolAddress,
          token0: POSITION.token0,
          token1: POSITION.token1,
          liquidityPercentageToDecrease: 100,
          rangeWidthBps: 800,
          decrease: { status: "pending", budgets: null },
          create: { status: "pending" },
          newNftTokenId: null,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    let decreases = 0;
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute", nftTokenId: null },
      ...store,
      discoverFn: async () => ({
        source: "list_v3_positions",
        truncated: false,
        count: 0,
        totalOwned: 0,
        nftTokenIds: [],
        positions: [],
      }),
      listPositions: async () => ({ truncated: false, positions: [] }),
      decreasePosition: async () => {
        decreases += 1;
        throw new Error("nope");
      },
    });
    assert.equal(decreases, 0);
    assert.equal(trace.results[0].execution.status, "needs_reconciliation");
    assert.equal(trace.status, "error");
  });

  it("needs_reopen is unsuccessful (top-level error / nonzero semantics)", async () => {
    const store = memoryStateStore();
    const trace = await runOnce({
      config: { ...CONFIG, agentMode: "execute" },
      ...store,
      getPosition: async () => POSITION,
      fetchMarket: async () => MARKET,
      extractFeaturesFn: () => FEATURES,
      requestDecisionFn: async () => rebalanceDecision(),
      listPositions: async () => ({
        truncated: false,
        positions: [
          {
            nftTokenId: "7",
            poolAddress: POSITION.poolAddress,
            liquidity: "1",
          },
        ],
      }),
      decreasePosition: async () => ({
        hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        nftTokenId: "7",
        liquidityPercentageToDecrease: 100,
        token0: { tokenAddress: POSITION.token0, amount: "0" },
        token1: { tokenAddress: POSITION.token1, amount: "0" },
      }),
      quoteTradeFn: async () => {
        throw new Error("should not quote");
      },
    });
    assert.equal(trace.results[0].status, "needs_attention");
    assert.equal(trace.results[0].execution.status, "needs_reopen");
    assert.equal(trace.status, "error");
  });
});
