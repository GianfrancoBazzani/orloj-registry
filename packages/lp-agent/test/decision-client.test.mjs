/**
 * Provider-neutral AI decision client — injected fetch, no MCP/execution.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_AI_TIMEOUT_MS,
  buildDecisionMessages,
  extractChatCompletionJsonText,
  pairContextFromMarket,
  requestDecision,
} from "../src/decision-client.mjs";
import { redactSecrets } from "../src/orloj-mcp-client.mjs";

const API_KEY = "ai_test_secret_key_xyz";
const URL = "https://example.com/v1/chat/completions";

const FEATURES = {
  position: {
    nftTokenId: "7",
    chainId: "11155111",
    poolAddress: "0xabc",
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
  windows: { nowUnix: 1_700_000_000 },
  volatility: {
    tickProxy6h: {
      sufficient: true,
      tickMovement: { value: 40 },
      sampleCount: 5,
      observationSpanSeconds: 14400,
      minSpanSeconds: 7200,
    },
    tickProxy24h: {
      sufficient: false,
      tickMovement: { value: null, reason: "sparse" },
      sampleCount: 2,
      observationSpanSeconds: 3600,
      minSpanSeconds: 43200,
    },
  },
  activity: {
    txCountSum6h: { value: 2 },
    txCountSum24h: { value: 8 },
    note: "Activity uses summed PoolHourData.txCount; not sampled swap row counts",
  },
  volumes: {
    token0_6h: { value: 1.5 },
    token1_6h: { value: 0 },
    trendToken0_6hVsPrev6h: { value: 0.2 },
  },
  fees: {
    usd_6h: { value: null, reason: "usd_unusable" },
    feeToTvl_24h: { value: null, reason: "usd_unusable" },
  },
  liquidity: {
    positionLiquidity: "5000",
    poolLiquidity: "9000",
    trend_24h: { value: -0.2 },
  },
  tvl: { trend_24h: { value: null, reason: "usd_unusable" } },
  usdDataUsable: { usable: false, reasons: ["test"] },
  graph: {
    subgraphId: "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
    indexedBlock: "11348887",
    indexedTimestamp: "1699999900",
    ageSeconds: 100,
    maxIndexedAgeSeconds: 3600,
    swapSample: { truncated: false, complete: true, rowCount: 0 },
  },
  evidence: { hourRows6h: 4, swapRowsSampled: 0 },
  missingInputFlags: ["usd_data_unusable", "insufficient_volatility_samples_24h"],
};

const PAIR = {
  token0: { id: "0x01", symbol: "AAA", decimals: "18" },
  token1: { id: "0x02", symbol: "BBB", decimals: "6" },
  feeTier: "3000",
};

function holdDecision() {
  return {
    action: "HOLD",
    confidence: 0.6,
    liquidityPercentageToDecrease: null,
    summary: "In range with measured low activity; USD ignored.",
    signals: [
      {
        direction: "neutral",
        observation: "In range; activity txCountSum6h is 2.",
        citations: ["range.status", "activity.txCountSum6h"],
      },
    ],
    uncertainties: ["usdDataUsable.usable is false"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: ["range.status", "activity.txCountSum6h", "graph.ageSeconds"],
    },
  };
}

function reduceDecision() {
  return {
    action: "REDUCE_LIQUIDITY",
    confidence: 0.85,
    liquidityPercentageToDecrease: 40,
    summary: "Near lower boundary with adverse liquidity trend.",
    signals: [
      {
        direction: "risk_up",
        observation: "Nearest boundary is lower at distance 10.",
        citations: ["range.nearestBoundary", "range.nearestBoundaryDistance"],
      },
      {
        direction: "risk_up",
        observation: "Pool liquidity trend declining.",
        citations: ["liquidity.trend_24h"],
      },
    ],
    uncertainties: ["volatility.tickProxy24h insufficient"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: [
        "range.nearestBoundaryDistance",
        "liquidity.trend_24h",
        "missingInputFlags",
      ],
    },
  };
}

function completionEnvelope(content) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  };
}

describe("decision-client", () => {
  it("exports a default AI timeout", () => {
    assert.equal(DEFAULT_AI_TIMEOUT_MS, 30_000);
  });

  it("buildDecisionMessages explains null vs zero, USD gate, and activity source", () => {
    const messages = buildDecisionMessages({ features: FEATURES, pair: PAIR });
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /null means insufficient evidence/i);
    assert.match(messages[0].content, /numeric zero means measured zero/i);
    assert.match(messages[0].content, /usdDataUsable\.usable is false/i);
    assert.match(messages[0].content, /PoolHourData\.txCount/);
    assert.match(messages[0].content, /Sampled swap row counts are NOT total intensity/i);
    assert.match(messages[0].content, /missingInputFlags/);
    assert.match(messages[0].content, /REDUCE_LIQUIDITY requires multiple independent signals/);
    assert.equal(messages[1].role, "user");
    const user = JSON.parse(messages[1].content);
    assert.equal(user.pair.token0.symbol, "AAA");
    assert.equal(user.pair.token1.decimals, "6");
    assert.equal(user.features.usdDataUsable.usable, false);
    assert.ok(user.features.missingInputFlags.includes("usd_data_unusable"));
    assert.equal(JSON.stringify(user).includes(API_KEY), false);
  });

  it("pairContextFromMarket reads validated symbols/decimals", () => {
    const pair = pairContextFromMarket({
      pool: {
        feeTier: "3000",
        token0: { id: "0x01", symbol: "AAA", decimals: "18" },
        token1: { id: "0x02", symbol: "BBB", decimals: "6" },
      },
    });
    assert.deepEqual(pair?.token0.symbol, "AAA");
    assert.equal(pairContextFromMarket({}), null);
  });

  it("extractChatCompletionJsonText accepts direct JSON only", () => {
    const text = extractChatCompletionJsonText(
      completionEnvelope(JSON.stringify(holdDecision())),
    );
    assert.equal(JSON.parse(text).action, "HOLD");
  });

  it("rejects markdown fences and prose", () => {
    assert.throws(
      () =>
        extractChatCompletionJsonText(
          completionEnvelope("```json\n" + JSON.stringify(holdDecision()) + "\n```"),
        ),
      /markdown fences/,
    );
    assert.throws(
      () =>
        extractChatCompletionJsonText(
          completionEnvelope("Here you go: " + JSON.stringify(holdDecision())),
        ),
      /prose rejected/,
    );
  });

  it("rejects malformed completion envelopes", () => {
    assert.throws(() => extractChatCompletionJsonText(null), /plain object/);
    assert.throws(() => extractChatCompletionJsonText({ choices: [] }), /missing choices/);
    assert.throws(
      () =>
        extractChatCompletionJsonText({
          choices: [{ message: { content: 123 } }],
        }),
      /must be a string/,
    );
  });

  it("requestDecision returns validated HOLD via injected fetch", async () => {
    const decision = await requestDecision(
      {
        aiChatCompletionsUrl: URL,
        aiApiKey: API_KEY,
        aiModel: "test-model",
        fetchImpl: async (url, init) => {
          assert.equal(url, URL);
          assert.match(init.headers.authorization, /Bearer /);
          assert.equal(init.headers.authorization.includes(API_KEY), true);
          const body = JSON.parse(init.body);
          assert.equal(body.model, "test-model");
          assert.equal(body.messages.length, 2);
          return jsonResponse(completionEnvelope(JSON.stringify(holdDecision())));
        },
      },
      { features: FEATURES, pair: PAIR },
    );
    assert.equal(decision.action, "HOLD");
    assert.equal(decision.liquidityPercentageToDecrease, null);
  });

  it("requestDecision returns validated REDUCE_LIQUIDITY", async () => {
    const decision = await requestDecision(
      {
        aiChatCompletionsUrl: URL,
        aiApiKey: API_KEY,
        aiModel: "test-model",
        fetchImpl: async () =>
          jsonResponse(completionEnvelope(JSON.stringify(reduceDecision()))),
      },
      { features: FEATURES, pair: PAIR },
    );
    assert.equal(decision.action, "REDUCE_LIQUIDITY");
    assert.equal(decision.liquidityPercentageToDecrease, 40);
  });

  it("throws on schema-invalid model JSON (never HOLD)", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () =>
              jsonResponse(
                completionEnvelope(
                  JSON.stringify({ action: "HOLD", confidence: 1 }),
                ),
              ),
          },
          { features: FEATURES },
        ),
      /unexpected or missing fields|must be a/,
    );
  });

  it("throws on hallucinated feature paths from the model", async () => {
    const bad = holdDecision();
    bad.signals[0].citations = ["range.doesNotExist"];
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () =>
              jsonResponse(completionEnvelope(JSON.stringify(bad))),
          },
          { features: FEATURES },
        ),
      /nonexistent feature path/,
    );
  });

  it("fail closed: HTTP errors with API key redacted", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            timeoutMs: 5_000,
            fetchImpl: async () => ({
              ok: false,
              status: 401,
              text: async () => `unauthorized key=${API_KEY}`,
            }),
          },
          { features: FEATURES },
        ),
      (err) => {
        assert.match(String(err.message), /AI HTTP 401/);
        assert.equal(String(err.message).includes(API_KEY), false);
        assert.match(String(err.message), /\[REDACTED\]/);
        return true;
      },
    );
  });

  it("fail closed: timeout during fetch", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
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
          { features: FEATURES },
        ),
      /AI request timed out after 20ms/,
    );
  });

  it("fail closed: timeout remains active through body read", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            timeoutMs: 25,
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                return JSON.stringify(completionEnvelope("{}"));
              },
            }),
          },
          { features: FEATURES },
        ),
      /AI request timed out after 25ms/,
    );
  });

  it("fail closed: body-read errors are redacted", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            timeoutMs: 5_000,
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => {
                throw new Error(`socket fail Bearer ${API_KEY}`);
              },
            }),
          },
          { features: FEATURES },
        ),
      (err) => {
        assert.match(String(err.message), /AI HTTP body read failed/);
        assert.equal(String(err.message).includes(API_KEY), false);
        return true;
      },
    );
    assert.equal(
      redactSecrets(`Bearer ${API_KEY}`, API_KEY),
      "Bearer [REDACTED]",
    );
  });

  it("rejects malformed model responses (fenced / invalid envelope)", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () =>
              jsonResponse(
                completionEnvelope(
                  "```json\n" + JSON.stringify(holdDecision()) + "\n```",
                ),
              ),
          },
          { features: FEATURES },
        ),
      /markdown fences/,
    );
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () => jsonResponse({ choices: [] }),
          },
          { features: FEATURES },
        ),
      /missing choices/,
    );
  });
});
