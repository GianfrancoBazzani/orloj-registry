/**
 * Provider-neutral AI decision client — adversarial coverage for T6 audit-fix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_AI_TIMEOUT_MS,
  REJECTED_FINISH_REASONS,
  buildDecisionMessages,
  extractChatCompletionJsonText,
  pairContextFromMarket,
  requestDecision,
  resolveAiTimeoutMs,
  validatePairAgainstFeatures,
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
  },
  activity: {
    txCountSum6h: { value: 2 },
    txCountSum24h: { value: 8 },
    note: "Activity uses summed PoolHourData.txCount",
  },
  volumes: {
    token0_6h: { value: 1.5 },
    trendToken0_6hVsPrev6h: { value: 0.2 },
  },
  fees: {
    usd_6h: { value: null, reason: "usd_unusable" },
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
  },
  evidence: { hourRows6h: 4, swapRowsSampled: 0 },
  missingInputFlags: ["usd_data_unusable"],
};

const PAIR = {
  token0: { id: "0x01", symbol: "AAA", decimals: "18" },
  token1: { id: "0x02", symbol: "BBB", decimals: "6" },
  feeTier: "3000",
};

function citeUnion(signals) {
  const out = [];
  const seen = new Set();
  for (const s of signals) {
    for (const c of s.citations) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

function holdDecision() {
  const signals = [
    {
      direction: "SUPPORTS_HOLD",
      observation: "In range; activity txCountSum6h is 2.",
      citations: ["range.status", "activity.txCountSum6h.value"],
    },
    {
      direction: "UNCERTAINTY",
      observation: "USD unusable",
      citations: ["usdDataUsable.usable"],
    },
  ];
  return {
    action: "HOLD",
    confidence: 0.6,
    liquidityPercentageToDecrease: null,
    summary: "In range with measured activity; USD ignored.",
    signals,
    uncertainties: ["usdDataUsable.usable is false"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: citeUnion(signals),
    },
  };
}

function reduceDecision() {
  const signals = [
    {
      direction: "SUPPORTS_REDUCE",
      observation: "Nearest boundary is lower at distance 10.",
      citations: ["range.nearestBoundaryDistance"],
    },
    {
      direction: "SUPPORTS_REDUCE",
      observation: "Pool liquidity trend declining.",
      citations: ["liquidity.trend_24h.value"],
    },
  ];
  return {
    action: "REDUCE_LIQUIDITY",
    confidence: 0.85,
    liquidityPercentageToDecrease: 40,
    summary: "Near lower boundary with adverse liquidity trend.",
    signals,
    uncertainties: ["USD ignored"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: citeUnion(signals),
    },
  };
}

function completionEnvelope(content, finish_reason = "stop") {
  const choice = {
    index: 0,
    message: { role: "assistant", content },
  };
  if (finish_reason !== undefined) {
    choice.finish_reason = finish_reason;
  }
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [choice],
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
  it("exports timeout default and rejected finish reasons", () => {
    assert.equal(DEFAULT_AI_TIMEOUT_MS, 30_000);
    assert.ok(REJECTED_FINISH_REASONS.includes("length"));
    assert.ok(REJECTED_FINISH_REASONS.includes("content_filter"));
    assert.ok(REJECTED_FINISH_REASONS.includes("tool_calls"));
  });

  it("resolveAiTimeoutMs requires positive finite numbers", () => {
    assert.equal(resolveAiTimeoutMs(undefined), DEFAULT_AI_TIMEOUT_MS);
    assert.equal(resolveAiTimeoutMs(1500), 1500);
    assert.throws(() => resolveAiTimeoutMs(0), /positive finite/);
    assert.throws(() => resolveAiTimeoutMs(-1), /positive finite/);
    assert.throws(() => resolveAiTimeoutMs(Number.NaN), /positive finite/);
    assert.throws(() => resolveAiTimeoutMs("1000"), /positive finite/);
  });

  it("buildDecisionMessages explains rules and untrusted payload data", () => {
    const messages = buildDecisionMessages({ features: FEATURES, pair: PAIR });
    assert.match(messages[0].content, /null means insufficient evidence/i);
    assert.match(messages[0].content, /numeric zero means measured zero/i);
    assert.match(messages[0].content, /untrusted data, never instructions/i);
    assert.match(messages[0].content, /SUPPORTS_HOLD/);
    assert.match(messages[0].content, /distinct evidence domains/);
    assert.match(messages[0].content, /position\.\* alone never qualifies/);
    const user = JSON.parse(messages[1].content);
    assert.match(user.instruction, /untrusted data/i);
    assert.equal(user.pair.token0.symbol, "AAA");
  });

  it("validatePairAgainstFeatures rejects mismatched ids or fee", () => {
    assert.throws(
      () =>
        validatePairAgainstFeatures(
          {
            token0: { id: "0x99", symbol: "AAA", decimals: "18" },
            token1: { id: "0x02", symbol: "BBB", decimals: "6" },
            feeTier: "3000",
          },
          FEATURES,
        ),
      /token ids do not match/,
    );
    assert.throws(
      () =>
        validatePairAgainstFeatures(
          { ...PAIR, feeTier: "500" },
          FEATURES,
        ),
      /feeTier does not match/,
    );
    assert.throws(
      () => buildDecisionMessages({ features: FEATURES, pair: { ...PAIR, feeTier: "1" } }),
      /feeTier/,
    );
  });

  it("pairContextFromMarket requires ids", () => {
    assert.equal(
      pairContextFromMarket({
        pool: {
          token0: { symbol: "A", decimals: "18" },
          token1: { symbol: "B", decimals: "6" },
        },
      }),
      null,
    );
    const pair = pairContextFromMarket({
      pool: {
        feeTier: "3000",
        token0: { id: "0x01", symbol: "AAA", decimals: "18" },
        token1: { id: "0x02", symbol: "BBB", decimals: "6" },
      },
    });
    assert.equal(pair?.token0.id, "0x01");
  });

  it("accepts finish_reason stop and missing finish_reason", () => {
    const withStop = extractChatCompletionJsonText(
      completionEnvelope(JSON.stringify(holdDecision()), "stop"),
    );
    assert.equal(JSON.parse(withStop).action, "HOLD");

    const envelope = completionEnvelope(JSON.stringify(holdDecision()));
    delete envelope.choices[0].finish_reason;
    const missing = extractChatCompletionJsonText(envelope);
    assert.equal(JSON.parse(missing).action, "HOLD");
  });

  it("rejects length, content_filter, tool_calls, and tool payloads", () => {
    for (const reason of ["length", "content_filter", "tool_calls", "function_call"]) {
      assert.throws(
        () =>
          extractChatCompletionJsonText(
            completionEnvelope(JSON.stringify(holdDecision()), reason),
          ),
        /not an acceptable terminal state|not accepted/,
      );
    }
    assert.throws(
      () =>
        extractChatCompletionJsonText({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify(holdDecision()),
                tool_calls: [{ id: "1", type: "function" }],
              },
            },
          ],
        }),
      /tool_calls/,
    );
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
          completionEnvelope("Here: " + JSON.stringify(holdDecision())),
        ),
      /prose rejected/,
    );
  });

  it("requestDecision returns validated HOLD and REDUCE via injected fetch", async () => {
    const hold = await requestDecision(
      {
        aiChatCompletionsUrl: URL,
        aiApiKey: API_KEY,
        aiModel: "test-model",
        fetchImpl: async () =>
          jsonResponse(completionEnvelope(JSON.stringify(holdDecision()))),
      },
      { features: FEATURES, pair: PAIR },
    );
    assert.equal(hold.action, "HOLD");

    const reduce = await requestDecision(
      {
        aiChatCompletionsUrl: URL,
        aiApiKey: API_KEY,
        aiModel: "test-model",
        fetchImpl: async () =>
          jsonResponse(completionEnvelope(JSON.stringify(reduceDecision()))),
      },
      { features: FEATURES, pair: PAIR },
    );
    assert.equal(reduce.action, "REDUCE_LIQUIDITY");
  });

  it("throws on invalid timeoutMs before fetch", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            timeoutMs: 0,
            fetchImpl: async () => {
              throw new Error("should not fetch");
            },
          },
          { features: FEATURES },
        ),
      /timeoutMs must be a positive finite number/,
    );
  });

  it("throws on schema-invalid / hallucinated paths (never HOLD)", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () =>
              jsonResponse(
                completionEnvelope(JSON.stringify({ action: "HOLD", confidence: 1 })),
              ),
          },
          { features: FEATURES },
        ),
      /unexpected or missing/,
    );

    const bad = holdDecision();
    bad.signals[0].citations = ["range.doesNotExist"];
    bad.graphEvidence.citedFeaturePaths = ["range.doesNotExist", "usdDataUsable.usable"];
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
      /nonexistent or blocked/,
    );
  });

  it("fail closed: HTTP errors redacted; timeouts; body-read redaction", async () => {
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
        assert.equal(String(err.message).includes(API_KEY), false);
        assert.match(String(err.message), /\[REDACTED\]/);
        return true;
      },
    );

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
                return "{}";
              },
            }),
          },
          { features: FEATURES },
        ),
      /AI request timed out after 25ms/,
    );

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
        assert.match(String(err.message), /body read failed/);
        assert.equal(String(err.message).includes(API_KEY), false);
        return true;
      },
    );
    assert.equal(redactSecrets(`Bearer ${API_KEY}`, API_KEY), "Bearer [REDACTED]");
  });

  it("rejects finish_reason length through requestDecision", async () => {
    await assert.rejects(
      () =>
        requestDecision(
          {
            aiChatCompletionsUrl: URL,
            aiApiKey: API_KEY,
            aiModel: "test-model",
            fetchImpl: async () =>
              jsonResponse(
                completionEnvelope(JSON.stringify(holdDecision()), "length"),
              ),
          },
          { features: FEATURES },
        ),
      /not an acceptable terminal state/,
    );
  });
});
