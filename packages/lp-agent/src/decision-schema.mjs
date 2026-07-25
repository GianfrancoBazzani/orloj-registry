/**
 * Strict validation of AI decision JSON.
 * Phase 1 allowed actions: HOLD | REDUCE_LIQUIDITY (CLAIM_FEES / unknown rejected).
 * Invalid output throws — never coerce to HOLD.
 */

export const PHASE1_ACTIONS = Object.freeze(["HOLD", "REDUCE_LIQUIDITY"]);

/** REDUCE must cite at least this many signals. */
export const MIN_REDUCE_SIGNALS = 2;

const DECISION_KEYS = Object.freeze([
  "action",
  "confidence",
  "liquidityPercentageToDecrease",
  "summary",
  "signals",
  "uncertainties",
  "graphEvidence",
]);

const SIGNAL_KEYS = Object.freeze(["direction", "observation", "citations"]);

const GRAPH_EVIDENCE_KEYS = Object.freeze([
  "subgraphId",
  "indexedBlock",
  "ageSeconds",
  "citedFeaturePaths",
]);

/**
 * Resolve a dotted path against an object. Returns whether the path exists
 * (including null leaf values — null is present evidence, not a missing path).
 * @param {unknown} root
 * @param {string} path
 * @returns {boolean}
 */
export function featurePathExists(root, path) {
  if (typeof path !== "string" || path.trim() === "" || path.includes("..")) {
    return false;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    return false;
  }
  if (root === null || typeof root !== "object") {
    return false;
  }
  /** @type {unknown} */
  let cur = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in /** @type {object} */ (cur))) {
      return false;
    }
    cur = /** @type {Record<string, unknown>} */ (cur)[part];
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertExactKeys(value, label, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`decision ${label} must be a plain object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(
      `decision ${label} has unexpected or missing fields (allowed: ${expected.join(", ")})`,
    );
  }
}

/**
 * @param {unknown} decision
 * @param {object} features extractFeatures output — citation target
 * @returns {object} frozen-validated decision (plain object copy)
 */
export function validateDecision(decision, features) {
  if (features === null || typeof features !== "object" || Array.isArray(features)) {
    throw new Error("validateDecision requires features object for citation checks");
  }
  assertExactKeys(decision, "root", DECISION_KEYS);

  const d = /** @type {Record<string, unknown>} */ (decision);

  if (d.action === "CLAIM_FEES") {
    throw new Error('decision action "CLAIM_FEES" is not allowed in Phase 1');
  }
  if (d.action !== "HOLD" && d.action !== "REDUCE_LIQUIDITY") {
    throw new Error(
      `decision action must be HOLD or REDUCE_LIQUIDITY (got ${JSON.stringify(d.action)})`,
    );
  }

  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence)) {
    throw new Error("decision confidence must be a finite number");
  }
  if (d.confidence < 0 || d.confidence > 1) {
    throw new Error("decision confidence must be between 0 and 1 inclusive");
  }

  if (typeof d.summary !== "string" || d.summary.trim() === "") {
    throw new Error("decision summary must be a non-empty string");
  }

  if (!Array.isArray(d.signals) || d.signals.length === 0) {
    throw new Error("decision signals must be a nonempty array");
  }
  if (!Array.isArray(d.uncertainties)) {
    throw new Error("decision uncertainties must be an array");
  }
  for (let i = 0; i < d.uncertainties.length; i++) {
    if (typeof d.uncertainties[i] !== "string" || d.uncertainties[i].trim() === "") {
      throw new Error(`decision uncertainties[${i}] must be a non-empty string`);
    }
  }

  if (d.action === "HOLD") {
    if (d.liquidityPercentageToDecrease !== null) {
      throw new Error(
        "decision HOLD requires liquidityPercentageToDecrease to be null",
      );
    }
  } else {
    // REDUCE_LIQUIDITY
    if (
      typeof d.liquidityPercentageToDecrease !== "number" ||
      !Number.isInteger(d.liquidityPercentageToDecrease) ||
      d.liquidityPercentageToDecrease < 1 ||
      d.liquidityPercentageToDecrease > 100
    ) {
      throw new Error(
        "decision REDUCE_LIQUIDITY requires liquidityPercentageToDecrease integer 1–100",
      );
    }
    if (d.signals.length < MIN_REDUCE_SIGNALS) {
      throw new Error(
        `decision REDUCE_LIQUIDITY requires at least ${MIN_REDUCE_SIGNALS} independent signals`,
      );
    }
  }

  /** @type {string[]} */
  const allCitations = [];
  for (let i = 0; i < d.signals.length; i++) {
    const signal = d.signals[i];
    assertExactKeys(signal, `signals[${i}]`, SIGNAL_KEYS);
    const s = /** @type {Record<string, unknown>} */ (signal);
    if (typeof s.direction !== "string" || s.direction.trim() === "") {
      throw new Error(`decision signals[${i}].direction must be a non-empty string`);
    }
    if (typeof s.observation !== "string" || s.observation.trim() === "") {
      throw new Error(`decision signals[${i}].observation must be a non-empty string`);
    }
    if (!Array.isArray(s.citations) || s.citations.length === 0) {
      throw new Error(`decision signals[${i}].citations must be a nonempty array`);
    }
    for (let j = 0; j < s.citations.length; j++) {
      const cite = s.citations[j];
      if (typeof cite !== "string" || cite.trim() === "") {
        throw new Error(
          `decision signals[${i}].citations[${j}] must be a non-empty string`,
        );
      }
      if (!featurePathExists(features, cite)) {
        throw new Error(
          `decision signals[${i}].citations[${j}] cites nonexistent feature path ${JSON.stringify(cite)}`,
        );
      }
      allCitations.push(cite);
    }
  }

  if (d.action === "REDUCE_LIQUIDITY") {
    const distinct = new Set(allCitations);
    if (distinct.size < MIN_REDUCE_SIGNALS) {
      throw new Error(
        `decision REDUCE_LIQUIDITY requires citations to at least ${MIN_REDUCE_SIGNALS} distinct feature paths (independent signals)`,
      );
    }
  }

  assertExactKeys(d.graphEvidence, "graphEvidence", GRAPH_EVIDENCE_KEYS);
  const ge = /** @type {Record<string, unknown>} */ (d.graphEvidence);

  const expectedSubgraphId = features.graph?.subgraphId;
  if (typeof ge.subgraphId !== "string" || ge.subgraphId.trim() === "") {
    throw new Error("decision graphEvidence.subgraphId must be a non-empty string");
  }
  if (
    typeof expectedSubgraphId === "string" &&
    ge.subgraphId !== expectedSubgraphId
  ) {
    throw new Error(
      `decision graphEvidence.subgraphId does not match features (${ge.subgraphId} !== ${expectedSubgraphId})`,
    );
  }

  if (
    ge.indexedBlock === null ||
    ge.indexedBlock === undefined ||
    (typeof ge.indexedBlock !== "string" && typeof ge.indexedBlock !== "number") ||
    (typeof ge.indexedBlock === "number" && !Number.isFinite(ge.indexedBlock)) ||
    (typeof ge.indexedBlock === "string" && ge.indexedBlock.trim() === "")
  ) {
    throw new Error(
      "decision graphEvidence.indexedBlock must be a non-empty string or finite number",
    );
  }
  const expectedBlock = features.graph?.indexedBlock;
  if (
    expectedBlock !== undefined &&
    expectedBlock !== null &&
    String(ge.indexedBlock) !== String(expectedBlock)
  ) {
    throw new Error(
      `decision graphEvidence.indexedBlock does not match features (${ge.indexedBlock} !== ${expectedBlock})`,
    );
  }

  if (typeof ge.ageSeconds !== "number" || !Number.isFinite(ge.ageSeconds)) {
    throw new Error("decision graphEvidence.ageSeconds must be a finite number");
  }
  if (ge.ageSeconds < 0) {
    throw new Error("decision graphEvidence.ageSeconds must be non-negative");
  }
  const expectedAge = features.graph?.ageSeconds;
  if (
    typeof expectedAge === "number" &&
    Number.isFinite(expectedAge) &&
    ge.ageSeconds !== expectedAge
  ) {
    throw new Error(
      `decision graphEvidence.ageSeconds does not match features (${ge.ageSeconds} !== ${expectedAge})`,
    );
  }

  if (!Array.isArray(ge.citedFeaturePaths) || ge.citedFeaturePaths.length === 0) {
    throw new Error("decision graphEvidence.citedFeaturePaths must be a nonempty array");
  }
  for (let i = 0; i < ge.citedFeaturePaths.length; i++) {
    const path = ge.citedFeaturePaths[i];
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(
        `decision graphEvidence.citedFeaturePaths[${i}] must be a non-empty string`,
      );
    }
    if (!featurePathExists(features, path)) {
      throw new Error(
        `decision graphEvidence.citedFeaturePaths[${i}] cites nonexistent feature path ${JSON.stringify(path)}`,
      );
    }
  }

  return {
    action: d.action,
    confidence: d.confidence,
    liquidityPercentageToDecrease: d.liquidityPercentageToDecrease,
    summary: d.summary.trim(),
    signals: d.signals.map((signal) => {
      const s = /** @type {Record<string, unknown>} */ (signal);
      return {
        direction: /** @type {string} */ (s.direction).trim(),
        observation: /** @type {string} */ (s.observation).trim(),
        citations: [.../** @type {string[]} */ (s.citations)],
      };
    }),
    uncertainties: d.uncertainties.map((u) => /** @type {string} */ (u).trim()),
    graphEvidence: {
      subgraphId: /** @type {string} */ (ge.subgraphId).trim(),
      indexedBlock: ge.indexedBlock,
      ageSeconds: ge.ageSeconds,
      citedFeaturePaths: [.../** @type {string[]} */ (ge.citedFeaturePaths)],
    },
  };
}
