/**
 * Strict AI decision schema validation — adversarial coverage for T6 audit-fix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHASE1_ACTIONS,
  SIGNAL_DIRECTIONS,
  MIN_REDUCE_SUPPORT_SIGNALS,
  featurePathExists,
  resolveFeaturePath,
  isUsdDerivedPath,
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
    usd_6h: { value: 1.5 },
    feeToTvl_24h: { value: 0.01 },
  },
  liquidity: {
    positionLiquidity: "1000",
    poolLiquidity: "9999",
    trend_24h: { value: -0.1 },
  },
  tvl: {
    trend_24h: { value: 0.05 },
  },
  usdDataUsable: { usable: false, reasons: ["test_usd_bad"] },
  graph: {
    subgraphId: "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
    indexedBlock: "11348887",
    indexedTimestamp: "1700000000",
    ageSeconds: 42,
    maxIndexedAgeSeconds: 3600,
  },
  missingInputFlags: ["usd_data_unusable", "null:volumes.trendToken0_6hVsPrev6h"],
};

function citeUnion(...signals) {
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

function baseHold(overrides = {}) {
  const signals = overrides.signals ?? [
    {
      direction: "SUPPORTS_HOLD",
      observation: "Position is in range near mid.",
      citations: ["range.status", "range.inRange"],
    },
    {
      direction: "UNCERTAINTY",
      observation: "USD unusable.",
      citations: ["usdDataUsable.usable"],
    },
  ];
  const { signals: _s, graphEvidence: geOver, ...rest } = overrides;
  return {
    action: "HOLD",
    confidence: 0.7,
    liquidityPercentageToDecrease: null,
    summary: "Range healthy; low activity measured as zero in 6h.",
    signals,
    uncertainties: ["usd_data_unusable"],
    graphEvidence: {
      subgraphId: FEATURES.graph.subgraphId,
      indexedBlock: FEATURES.graph.indexedBlock,
      ageSeconds: FEATURES.graph.ageSeconds,
      citedFeaturePaths: citeUnion(...signals),
      ...geOver,
    },
    ...rest,
    signals,
  };
}

function baseReduce(overrides = {}) {
  const signals = overrides.signals ?? [
    {
      direction: "SUPPORTS_REDUCE",
      observation: "Nearest boundary distance is tight.",
      citations: ["range.nearestBoundaryDistance"],
    },
    {
      direction: "SUPPORTS_REDUCE",
      observation: "Liquidity trend declining over 24h.",
      citations: ["liquidity.trend_24h.value"],
    },
    {
      direction: "UNCERTAINTY",
      observation: "USD gate failed.",
      citations: ["usdDataUsable.reasons"],
    },
  ];
  const { signals: _s, graphEvidence: geOver, ...rest } = overrides;
  const ge = {
    subgraphId: FEATURES.graph.subgraphId,
    indexedBlock: FEATURES.graph.indexedBlock,
    ageSeconds: FEATURES.graph.ageSeconds,
    citedFeaturePaths: citeUnion(...signals),
    ...geOver,
  };
  if (geOver?.citedFeaturePaths) {
    ge.citedFeaturePaths = geOver.citedFeaturePaths;
  }
  return {
    action: "REDUCE_LIQUIDITY",
    confidence: 0.8,
    liquidityPercentageToDecrease: 25,
    summary: "Near boundary with declining liquidity.",
    signals,
    uncertainties: ["fees.usd_6h ignored — USD unusable"],
    graphEvidence: ge,
    ...rest,
    signals,
  };
}

describe("decision-schema", () => {
  it("exposes Phase 1 actions and direction enum", () => {
    assert.deepEqual([...PHASE1_ACTIONS], ["HOLD", "REDUCE_LIQUIDITY"]);
    assert.deepEqual(
      [...SIGNAL_DIRECTIONS],
      ["SUPPORTS_HOLD", "SUPPORTS_REDUCE", "UNCERTAINTY"],
    );
    assert.equal(MIN_REDUCE_SUPPORT_SIGNALS, 2);
  });

  it("resolveFeaturePath uses Object.hasOwn and blocks prototype pollution paths", () => {
    assert.equal(resolveFeaturePath(FEATURES, "range.status").ok, true);
    assert.equal(resolveFeaturePath(FEATURES, "__proto__.polluted").ok, false);
    assert.equal(resolveFeaturePath(FEATURES, "constructor").ok, false);
    assert.equal(resolveFeaturePath(FEATURES, "range.prototype").ok, false);
    assert.equal(featurePathExists(FEATURES, "range.madeUp"), false);
    // Inherited Object methods must not count as present via hasOwn
    assert.equal(featurePathExists(FEATURES, "toString"), false);
  });

  it("accepts valid HOLD and REDUCE", () => {
    assert.equal(validateDecision(baseHold(), FEATURES).action, "HOLD");
    assert.equal(validateDecision(baseReduce(), FEATURES).action, "REDUCE_LIQUIDITY");
  });

  it("rejects freeform direction (must be enum)", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "neutral",
                observation: "x",
                citations: ["range.status"],
              },
            ],
          }),
          FEATURES,
        ),
      /SUPPORTS_HOLD \| SUPPORTS_REDUCE \| UNCERTAINTY/,
    );
  });

  it("rejects REDUCE with same-domain only independence", () => {
    assert.throws(
      () =>
        validateDecision(
          baseReduce({
            signals: [
              {
                direction: "SUPPORTS_REDUCE",
                observation: "a",
                citations: ["range.status"],
              },
              {
                direction: "SUPPORTS_REDUCE",
                observation: "b",
                citations: ["range.inRange"],
              },
            ],
          }),
          FEATURES,
        ),
      /distinct evidence domains/,
    );
  });

  it("rejects REDUCE with fewer than two SUPPORTS_REDUCE", () => {
    assert.throws(
      () =>
        validateDecision(
          baseReduce({
            signals: [
              {
                direction: "SUPPORTS_REDUCE",
                observation: "only one",
                citations: ["range.nearestBoundaryDistance"],
              },
              {
                direction: "SUPPORTS_HOLD",
                observation: "wrong direction",
                citations: ["activity.txCountSum6h.value"],
              },
            ],
          }),
          FEATURES,
        ),
      /at least 2 SUPPORTS_REDUCE/,
    );
  });

  it("rejects position.* alone as the only support domain", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "SUPPORTS_HOLD",
                observation: "only position",
                citations: ["position.fee", "position.tickLower"],
              },
            ],
          }),
          FEATURES,
        ),
      /Graph-derived evidence domain/,
    );
  });

  it("rejects actionable citation of null/reason evidence", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "SUPPORTS_HOLD",
                observation: "bad",
                citations: ["volumes.trendToken0_6hVsPrev6h"],
              },
            ],
          }),
          FEATURES,
        ),
      /null\/reason evidence|non-null primitive/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "SUPPORTS_HOLD",
                observation: "bad leaf",
                citations: ["volumes.trendToken0_6hVsPrev6h.value"],
              },
            ],
          }),
          FEATURES,
        ),
      /null\/reason evidence/,
    );
  });

  it("allows null/reason only on UNCERTAINTY and does not count it for REDUCE domains", () => {
    const d = validateDecision(
      baseReduce({
        signals: [
          {
            direction: "SUPPORTS_REDUCE",
            observation: "range",
            citations: ["range.nearestBoundaryDistance"],
          },
          {
            direction: "SUPPORTS_REDUCE",
            observation: "activity",
            citations: ["activity.txCountSum24h.value"],
          },
          {
            direction: "UNCERTAINTY",
            observation: "null trend",
            citations: ["volumes.trendToken0_6hVsPrev6h.value"],
          },
        ],
      }),
      FEATURES,
    );
    assert.equal(d.action, "REDUCE_LIQUIDITY");
  });

  it("forbids USD-derived paths from supporting action when USD unusable", () => {
    assert.equal(isUsdDerivedPath("fees.usd_6h.value"), true);
    assert.throws(
      () =>
        validateDecision(
          baseReduce({
            signals: [
              {
                direction: "SUPPORTS_REDUCE",
                observation: "fees",
                citations: ["fees.usd_6h.value"],
              },
              {
                direction: "SUPPORTS_REDUCE",
                observation: "range",
                citations: ["range.status"],
              },
            ],
          }),
          FEATURES,
        ),
      /USD-derived/,
    );
  });

  it("allows USD-derived support when usdDataUsable.usable is true", () => {
    const usable = {
      ...FEATURES,
      usdDataUsable: { usable: true, reasons: [] },
    };
    const d = validateDecision(
      {
        action: "REDUCE_LIQUIDITY",
        confidence: 0.7,
        liquidityPercentageToDecrease: 10,
        summary: "Fee/TVL and range both adverse.",
        signals: [
          {
            direction: "SUPPORTS_REDUCE",
            observation: "fee pressure",
            citations: ["fees.feeToTvl_24h.value"],
          },
          {
            direction: "SUPPORTS_REDUCE",
            observation: "near edge",
            citations: ["range.nearestBoundaryDistance"],
          },
        ],
        uncertainties: [],
        graphEvidence: {
          subgraphId: usable.graph.subgraphId,
          indexedBlock: usable.graph.indexedBlock,
          ageSeconds: usable.graph.ageSeconds,
          citedFeaturePaths: [
            "fees.feeToTvl_24h.value",
            "range.nearestBoundaryDistance",
          ],
        },
      },
      usable,
    );
    assert.equal(d.action, "REDUCE_LIQUIDITY");
  });

  it("requires graphEvidence.citedFeaturePaths to equal citation union (no filler/dupes)", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              citedFeaturePaths: ["range.status", "range.inRange", "graph.ageSeconds"],
            },
          }),
          FEATURES,
        ),
      /deduplicated union/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "SUPPORTS_HOLD",
                observation: "x",
                citations: ["range.status", "range.inRange"],
              },
            ],
            graphEvidence: {
              citedFeaturePaths: ["range.status", "range.status", "range.inRange"],
            },
          }),
          FEATURES,
        ),
      /duplicate/,
    );
  });

  it("requires valid features.graph then exact match on all three fields", () => {
    assert.throws(
      () =>
        validateDecision(baseHold(), {
          ...FEATURES,
          graph: { ...FEATURES.graph, subgraphId: "" },
        }),
      /features\.graph\.subgraphId/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            graphEvidence: {
              citedFeaturePaths: citeUnion(...baseHold().signals),
              subgraphId: "wrong",
              indexedBlock: FEATURES.graph.indexedBlock,
              ageSeconds: FEATURES.graph.ageSeconds,
            },
          }),
          FEATURES,
        ),
      /subgraphId does not match/,
    );
  });

  it("rejects CLAIM_FEES, extra fields, contradictory percentages, empty evidence", () => {
    assert.throws(
      () => validateDecision(baseHold({ action: "CLAIM_FEES" }), FEATURES),
      /CLAIM_FEES/,
    );
    assert.throws(
      () => validateDecision({ ...baseHold(), extra: 1 }, FEATURES),
      /unexpected or missing/,
    );
    assert.throws(
      () =>
        validateDecision(
          baseHold({ liquidityPercentageToDecrease: 5 }),
          FEATURES,
        ),
      /null/,
    );
    assert.throws(
      () => validateDecision(baseHold({ signals: [] }), FEATURES),
      /nonempty/,
    );
  });

  it("rejects citing non-primitive objects for actionable support", () => {
    assert.throws(
      () =>
        validateDecision(
          baseHold({
            signals: [
              {
                direction: "SUPPORTS_HOLD",
                observation: "object leaf",
                citations: ["activity.txCountSum6h"],
              },
            ],
          }),
          FEATURES,
        ),
      /non-null primitive/,
    );
  });

  it("accepts measured zero primitive as actionable", () => {
    const d = validateDecision(
      baseHold({
        signals: [
          {
            direction: "SUPPORTS_HOLD",
            observation: "zero activity measured",
            citations: ["activity.txCountSum6h.value"],
          },
        ],
      }),
      FEATURES,
    );
    assert.equal(d.action, "HOLD");
  });
});
