/**
 * Strict AI decision schema validation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHASE1_ACTIONS,
  MIN_REDUCE_SIGNALS,
  featurePathExists,
  validateDecision,
} from "../src/decision-schema.mjs";

const FEATURES = {
  position: {
    nftTokenId: "1",
    chainId: "11155111",
    poolAddress: "0xabc",
    tickLower: 0,
    tickUpper: 100,
    positionLiquidity: "1000",
    fee: "3000",
    token0: "0x01",
    token1: "0x02",
  },
  range: {
    currentTick: 50,
    status: "in_range",
    inRange: true,
    width: 100,
    distanceToLower: 50,
    distanceToUpper: 50,
    nearestBoundary: "lower",
    nearestBoundaryDistance: 50,
    normalizedRangePosition: 0.5,
  },
  volatility: {
    tickProxy6h: {
      sufficient: true,
      tickMovement: { value: 12 },
      sampleCount: 4,
      observationSpanSeconds: 10800,
      minSpanSeconds: 7200,
    },
  },
  activity: {
    txCountSum6h: { value: 0 },
    txCountSum24h: { value: 3 },
    note: "Activity uses summed PoolHourData.txCount; not sampled swap row counts",
  },
  volumes: {
    token0_6h: { value: 1 },
    trendToken0_6hVsPrev6h: { value: null, reason: "missing_prev" },
  },
  fees: {
    usd_6h: { value: null, reason: "usd_unusable" },
  },
  liquidity: {
    positionLiquidity: "1000",
    poolLiquidity: "9999",
    trend_24h: { value: -0.1 },
  },
  usdDataUsable: { usable: false, reasons: ["test"] },
  graph: {
    subgraphId: "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
    indexedBlock: "11348887",
    indexedTimestamp: "1700000000",
    ageSeconds: 42,
    maxIndexedAgeSeconds: 3600,
  },
  missingInputFlags: ["usd_data_unusable", "null:volumes.trendToken0_6hVsPrev6h"],
};

function baseHold(overrides = {}) {
  return {
    action: "HOLD",
    confidence: 0.7,
    liquidityPercentageToDecrease: null,
    summary: "Range healthy; low activity measured as zero in 6h.",
    signals: [
      {
        direction: "neutral",
        observation: "Position is in range near mid.",
        citations: ["range.status", "range.inRange"],
      },
    ],
    uncertainties: ["usd_data_unusable"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: ["range.status", "graph.ageSeconds"],
    },
    ...overrides,
  };
}

function baseReduce(overrides = {}) {
  return {
    action: "REDUCE_LIQUIDITY",
    confidence: 0.8,
    liquidityPercentageToDecrease: 25,
    summary: "Near boundary with rising tick movement and liquidity drain.",
    signals: [
      {
        direction: "risk_up",
        observation: "Nearest boundary distance is tight.",
        citations: ["range.nearestBoundaryDistance"],
      },
      {
        direction: "risk_up",
        observation: "Liquidity trend declining over 24h.",
        citations: ["liquidity.trend_24h"],
      },
    ],
    uncertainties: ["fees.usd_6h is null"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: [
        "range.nearestBoundaryDistance",
        "liquidity.trend_24h",
        "volatility.tickProxy6h.tickMovement",
      ],
    },
    ...overrides,
  };
}

describe("decision-schema", () => {
  it("exposes Phase 1 actions only", () => {
    assert.deepEqual([...PHASE1_ACTIONS], ["HOLD", "REDUCE_LIQUIDITY"]);
    assert.equal(MIN_REDUCE_SIGNALS, 2);
  });

  it("featurePathExists resolves real paths including null leaves", () => {
    assert.equal(featurePathExists(FEATURES, "range.status"), true);
    assert.equal(
      featurePathExists(FEATURES, "volumes.trendToken0_6hVsPrev6h.value"),
      true,
    );
    assert.equal(featurePathExists(FEATURES, "volumes.nope"), false);
    assert.equal(featurePathExists(FEATURES, ""), false);
    assert.equal(featurePathExists(FEATURES, "range..status"), false);
  });

  it("accepts valid HOLD", () => {
    const d = validateDecision(baseHold(), FEATURES);
    assert.equal(d.action, "HOLD");
    assert.equal(d.liquidityPercentageToDecrease, null);
    assert.equal(d.confidence, 0.7);
  });

  it("accepts valid REDUCE_LIQUIDITY with independent signals", () => {
    const d = validateDecision(baseReduce(), FEATURES);
    assert.equal(d.action, "REDUCE_LIQUIDITY");
    assert.equal(d.liquidityPercentageToDecrease, 25);
    assert.equal(d.signals.length, 2);
  });

  it("rejects CLAIM_FEES", () => {
    assert.throws(
      () => validateDecision(baseHold({ action: "CLAIM_FEES" }), FEATURES),
      /CLAIM_FEES/,
    );
  });

  it("rejects unknown actions", () => {
    assert.throws(
      () => validateDecision(baseHold({ action: "CREATE_POSITION" }), FEATURES),
      /HOLD or REDUCE_LIQUIDITY/,
    );
  });

  it("rejects extra top-level fields", () => {
    const bad = { ...baseHold(), extra: true };
    assert.throws(() => validateDecision(bad, FEATURES), /unexpected or missing/);
  });

  it("rejects extra signal fields", () => {
    const bad = baseHold({
      signals: [
        {
          direction: "neutral",
          observation: "x",
          citations: ["range.status"],
          weight: 1,
        },
      ],
    });
    assert.throws(() => validateDecision(bad, FEATURES), /signals\[0\]/);
  });

  it("rejects malformed confidence", () => {
    assert.throws(
      () => validateDecision(baseHold({ confidence: "high" }), FEATURES),
      /confidence/,
    );
    assert.throws(
      () => validateDecision(baseHold({ confidence: 1.5 }), FEATURES),
      /between 0 and 1/,
    );
    assert.throws(
      () => validateDecision(baseHold({ confidence: Number.NaN }), FEATURES),
      /finite/,
    );
  });

  it("rejects contradictory percentages", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({ liquidityPercentageToDecrease: 10 }),
          FEATURES,
        ),
      /HOLD requires liquidityPercentageToDecrease to be null/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseReduce({ liquidityPercentageToDecrease: null }),
          FEATURES,
        ),
      /integer 1–100/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseReduce({ liquidityPercentageToDecrease: 0 }),
          FEATURES,
        ),
      /integer 1–100/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseReduce({ liquidityPercentageToDecrease: 12.5 }),
          FEATURES,
        ),
      /integer 1–100/,
    );
  });

  it("rejects empty signals / empty evidence", () => {
    assert.throws(
      () => validateDecision(baseHold({ signals: [] }), FEATURES),
      /nonempty array/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              ...baseHold().graphEvidence,
              citedFeaturePaths: [],
            },
          }),
          FEATURES,
        ),
      /citedFeaturePaths/,
    );
  });

  it("rejects empty summary and empty uncertainties entries", () => {
    assert.throws(
      () => validateDecision(baseHold({ summary: "  " }), FEATURES),
      /summary/,
    );
    assert.throws(
      () => validateDecision(baseHold({ uncertainties: [""] }), FEATURES),
      /uncertainties\[0\]/,
    );
  });

  it("rejects hallucinated feature path citations", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "neutral",
                observation: "made up",
                citations: ["range.madeUpField"],
              },
            ],
          }),
          FEATURES,
        ),
      /nonexistent feature path/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              ...baseHold().graphEvidence,
              citedFeaturePaths: ["fees.hallucinated"],
            },
          }),
          FEATURES,
        ),
      /nonexistent feature path/,
    );
  });

  it("rejects REDUCE with only one signal or duplicate-only citations", () => {
    assert.throws(
      () =>
        validateDecision(
          baseReduce({
            signals: [
              {
                direction: "risk_up",
                observation: "only one",
                citations: ["range.nearestBoundaryDistance"],
              },
            ],
          }),
          FEATURES,
        ),
      /at least 2 independent signals/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseReduce({
            signals: [
              {
                direction: "a",
                observation: "same path twice",
                citations: ["range.status"],
              },
              {
                direction: "b",
                observation: "still same path",
                citations: ["range.status"],
              },
            ],
          }),
          FEATURES,
        ),
      /distinct feature paths/,
    );
  });

  it("rejects mismatched graphEvidence vs features", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              ...baseHold().graphEvidence,
              subgraphId: "wrong",
            },
          }),
          FEATURES,
        ),
      /subgraphId does not match/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              ...baseHold().graphEvidence,
              ageSeconds: 999,
            },
          }),
          FEATURES,
        ),
      /ageSeconds does not match/,
    );
  });

  it("never silently coerces invalid output to HOLD", () => {
    assert.throws(() => validateDecision({ action: "HOLD" }, FEATURES));
    assert.throws(() => validateDecision(null, FEATURES));
    assert.throws(() => validateDecision("HOLD", FEATURES));
  });
});
