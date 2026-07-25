/**
 * Strict validation of AI decision JSON.
 * Phase 1 allowed actions: HOLD | REDUCE_LIQUIDITY (CLAIM_FEES / unknown rejected).
 * Invalid output throws — never coerce to HOLD.
 */

export const PHASE1_ACTIONS = Object.freeze(["HOLD", "REDUCE_LIQUIDITY"]);

/** Signal direction enum. */
export const SIGNAL_DIRECTIONS = Object.freeze([
  "SUPPORTS_HOLD",
  "SUPPORTS_REDUCE",
  "UNCERTAINTY",
]);

/** REDUCE must include at least this many SUPPORTS_REDUCE signals from distinct domains. */
export const MIN_REDUCE_SUPPORT_SIGNALS = 2;

/** @deprecated use MIN_REDUCE_SUPPORT_SIGNALS */
export const MIN_REDUCE_SIGNALS = MIN_REDUCE_SUPPORT_SIGNALS;

/** Top-level feature namespaces that are live Graph-derived (not Orloj position alone). */
export const GRAPH_EVIDENCE_DOMAINS = Object.freeze([
  "range",
  "windows",
  "volatility",
  "activity",
  "volumes",
  "fees",
  "liquidity",
  "tvl",
  "usdDataUsable",
  "graph",
  "evidence",
  "missingInputFlags",
]);

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

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
 * @param {string} path
 * @returns {string} top-level domain
 */
export function evidenceDomainForPath(path) {
  const domain = path.split(".")[0];
  return domain;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isGraphDerivedDomain(path) {
  return GRAPH_EVIDENCE_DOMAINS.includes(evidenceDomainForPath(path));
}

/**
 * USD-derived feature paths that must not support HOLD/REDUCE when USD is unusable.
 * @param {string} path
 * @returns {boolean}
 */
export function isUsdDerivedPath(path) {
  const domain = evidenceDomainForPath(path);
  if (domain === "fees" || domain === "tvl" || domain === "usdDataUsable") {
    return true;
  }
  return /(\.|^)(volumeUSD|feesUSD|tvlUSD|totalValueLockedUSD|feeToTvl)/i.test(
    path,
  );
}

/**
 * @param {unknown} leaf
 * @returns {boolean}
 */
export function isNullReasonEvidence(leaf) {
  if (leaf === null) return true;
  if (leaf !== null && typeof leaf === "object" && !Array.isArray(leaf)) {
    if (Object.hasOwn(leaf, "value") && /** @type {{value: unknown}} */ (leaf).value === null) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} leaf
 * @returns {boolean}
 */
export function isActionablePrimitive(leaf) {
  const t = typeof leaf;
  return leaf !== null && (t === "string" || t === "number" || t === "boolean");
}

/**
 * Resolve a dotted path with Object.hasOwn (no prototype chain).
 * Rejects __proto__, prototype, and constructor segments.
 *
 * @param {unknown} root
 * @param {string} path
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function resolveFeaturePath(root, path) {
  if (typeof path !== "string" || path.trim() === "" || path.includes("..")) {
    return { ok: false, reason: "invalid_path" };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    return { ok: false, reason: "invalid_path_syntax" };
  }
  if (root === null || typeof root !== "object") {
    return { ok: false, reason: "invalid_root" };
  }

  /** @type {unknown} */
  let cur = root;
  for (const part of path.split(".")) {
    if (BLOCKED_PATH_SEGMENTS.has(part)) {
      return { ok: false, reason: "blocked_segment" };
    }
    if (cur === null || typeof cur !== "object") {
      return { ok: false, reason: "nonexistent" };
    }
    if (!Object.hasOwn(cur, part)) {
      return { ok: false, reason: "nonexistent" };
    }
    cur = /** @type {Record<string, unknown>} */ (cur)[part];
  }
  return { ok: true, value: cur };
}

/**
 * @param {unknown} root
 * @param {string} path
 * @returns {boolean}
 */
export function featurePathExists(root, path) {
  return resolveFeaturePath(root, path).ok;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {readonly string[]} allowed
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
 * Features.graph must expose the three identity fields before matching.
 * @param {object} features
 */
export function requireValidFeaturesGraph(features) {
  const g = features.graph;
  if (g === null || typeof g !== "object" || Array.isArray(g)) {
    throw new Error("features.graph must be a present object");
  }
  if (typeof g.subgraphId !== "string" || g.subgraphId.trim() === "") {
    throw new Error("features.graph.subgraphId must be a non-empty string");
  }
  if (
    g.indexedBlock === null ||
    g.indexedBlock === undefined ||
    (typeof g.indexedBlock !== "string" && typeof g.indexedBlock !== "number") ||
    (typeof g.indexedBlock === "number" && !Number.isFinite(g.indexedBlock)) ||
    (typeof g.indexedBlock === "string" && g.indexedBlock.trim() === "")
  ) {
    throw new Error(
      "features.graph.indexedBlock must be a non-empty string or finite number",
    );
  }
  if (typeof g.ageSeconds !== "number" || !Number.isFinite(g.ageSeconds) || g.ageSeconds < 0) {
    throw new Error("features.graph.ageSeconds must be a finite non-negative number");
  }
  return g;
}

/**
 * @param {unknown} decision
 * @param {object} features extractFeatures output — citation target
 * @returns {object} validated decision (plain object copy)
 */
export function validateDecision(decision, features) {
  if (features === null || typeof features !== "object" || Array.isArray(features)) {
    throw new Error("validateDecision requires features object for citation checks");
  }
  const featuresGraph = requireValidFeaturesGraph(features);
  const usdUsable = features.usdDataUsable?.usable === true;

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
  } else if (
    typeof d.liquidityPercentageToDecrease !== "number" ||
    !Number.isInteger(d.liquidityPercentageToDecrease) ||
    d.liquidityPercentageToDecrease < 1 ||
    d.liquidityPercentageToDecrease > 100
  ) {
    throw new Error(
      "decision REDUCE_LIQUIDITY requires liquidityPercentageToDecrease integer 1–100",
    );
  }

  /** @type {string[]} */
  const allCitations = [];
  /** @type {Array<{ direction: string, domains: Set<string>, citations: string[] }>} */
  const supportSignals = [];

  for (let i = 0; i < d.signals.length; i++) {
    const signal = d.signals[i];
    assertExactKeys(signal, `signals[${i}]`, SIGNAL_KEYS);
    const s = /** @type {Record<string, unknown>} */ (signal);

    if (typeof s.direction !== "string" || !SIGNAL_DIRECTIONS.includes(s.direction)) {
      throw new Error(
        `decision signals[${i}].direction must be one of ${SIGNAL_DIRECTIONS.join(" | ")}`,
      );
    }
    const direction = /** @type {string} */ (s.direction);

    if (typeof s.observation !== "string" || s.observation.trim() === "") {
      throw new Error(`decision signals[${i}].observation must be a non-empty string`);
    }
    if (!Array.isArray(s.citations) || s.citations.length === 0) {
      throw new Error(`decision signals[${i}].citations must be a nonempty array`);
    }

    /** @type {string[]} */
    const signalCitations = [];
    /** @type {Set<string>} */
    const domains = new Set();

    for (let j = 0; j < s.citations.length; j++) {
      const cite = s.citations[j];
      if (typeof cite !== "string" || cite.trim() === "") {
        throw new Error(
          `decision signals[${i}].citations[${j}] must be a non-empty string`,
        );
      }
      const resolved = resolveFeaturePath(features, cite);
      if (!resolved.ok) {
        throw new Error(
          `decision signals[${i}].citations[${j}] cites nonexistent or blocked feature path ${JSON.stringify(cite)}`,
        );
      }

      const leaf = resolved.value;
      const nullReason = isNullReasonEvidence(leaf);

      if (direction === "UNCERTAINTY") {
        // Null/reason evidence is allowed; actionable primitives also OK for uncertainty notes.
      } else {
        // SUPPORTS_HOLD | SUPPORTS_REDUCE — actionable non-null primitives only.
        if (nullReason) {
          throw new Error(
            `decision signals[${i}].citations[${j}] is null/reason evidence and may only be cited by UNCERTAINTY`,
          );
        }
        if (!isActionablePrimitive(leaf)) {
          throw new Error(
            `decision signals[${i}].citations[${j}] must resolve to a non-null primitive for actionable support`,
          );
        }
        if (!usdUsable && isUsdDerivedPath(cite)) {
          throw new Error(
            `decision signals[${i}].citations[${j}] is USD-derived while usdDataUsable.usable is false (cite as UNCERTAINTY instead)`,
          );
        }
        domains.add(evidenceDomainForPath(cite));
      }

      signalCitations.push(cite);
      allCitations.push(cite);
    }

    if (direction === "SUPPORTS_HOLD" || direction === "SUPPORTS_REDUCE") {
      supportSignals.push({ direction, domains, citations: signalCitations });
    }
  }

  // Action-aligned support + independence.
  if (d.action === "HOLD") {
    const holdSupports = supportSignals.filter((s) => s.direction === "SUPPORTS_HOLD");
    if (holdSupports.length < 1) {
      throw new Error("decision HOLD requires at least one SUPPORTS_HOLD signal");
    }
  } else {
    const reduceSupports = supportSignals.filter((s) => s.direction === "SUPPORTS_REDUCE");
    if (reduceSupports.length < MIN_REDUCE_SUPPORT_SIGNALS) {
      throw new Error(
        `decision REDUCE_LIQUIDITY requires at least ${MIN_REDUCE_SUPPORT_SIGNALS} SUPPORTS_REDUCE signals`,
      );
    }
    /** @type {Set<string>} */
    const reduceDomains = new Set();
    for (const s of reduceSupports) {
      for (const dom of s.domains) reduceDomains.add(dom);
    }
    if (reduceDomains.size < MIN_REDUCE_SUPPORT_SIGNALS) {
      throw new Error(
        `decision REDUCE_LIQUIDITY requires SUPPORTS_REDUCE citations from at least ${MIN_REDUCE_SUPPORT_SIGNALS} distinct evidence domains`,
      );
    }
  }

  // Every decision needs ≥1 live Graph-derived domain among actionable support citations.
  /** @type {Set<string>} */
  const supportGraphDomains = new Set();
  for (const s of supportSignals) {
    for (const cite of s.citations) {
      const resolved = resolveFeaturePath(features, cite);
      if (!resolved.ok) continue;
      if (isNullReasonEvidence(resolved.value)) continue;
      if (!isActionablePrimitive(resolved.value)) continue;
      if (!usdUsable && isUsdDerivedPath(cite)) continue;
      if (isGraphDerivedDomain(cite)) {
        supportGraphDomains.add(evidenceDomainForPath(cite));
      }
    }
  }
  if (supportGraphDomains.size < 1) {
    throw new Error(
      "decision requires at least one live Graph-derived evidence domain (position.* alone never qualifies)",
    );
  }

  assertExactKeys(d.graphEvidence, "graphEvidence", GRAPH_EVIDENCE_KEYS);
  const ge = /** @type {Record<string, unknown>} */ (d.graphEvidence);

  if (typeof ge.subgraphId !== "string" || ge.subgraphId.trim() === "") {
    throw new Error("decision graphEvidence.subgraphId must be a non-empty string");
  }
  if (ge.subgraphId !== featuresGraph.subgraphId) {
    throw new Error(
      `decision graphEvidence.subgraphId does not match features (${ge.subgraphId} !== ${featuresGraph.subgraphId})`,
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
  if (String(ge.indexedBlock) !== String(featuresGraph.indexedBlock)) {
    throw new Error(
      `decision graphEvidence.indexedBlock does not match features (${ge.indexedBlock} !== ${featuresGraph.indexedBlock})`,
    );
  }

  if (typeof ge.ageSeconds !== "number" || !Number.isFinite(ge.ageSeconds)) {
    throw new Error("decision graphEvidence.ageSeconds must be a finite number");
  }
  if (ge.ageSeconds !== featuresGraph.ageSeconds) {
    throw new Error(
      `decision graphEvidence.ageSeconds does not match features (${ge.ageSeconds} !== ${featuresGraph.ageSeconds})`,
    );
  }

  if (!Array.isArray(ge.citedFeaturePaths) || ge.citedFeaturePaths.length === 0) {
    throw new Error("decision graphEvidence.citedFeaturePaths must be a nonempty array");
  }

  /** Deduplicated union of signal citations in first-seen order. */
  const expectedUnion = [];
  const seenCite = new Set();
  for (const cite of allCitations) {
    if (!seenCite.has(cite)) {
      seenCite.add(cite);
      expectedUnion.push(cite);
    }
  }

  const cited = ge.citedFeaturePaths;
  const citedSeen = new Set();
  for (let i = 0; i < cited.length; i++) {
    const path = cited[i];
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(
        `decision graphEvidence.citedFeaturePaths[${i}] must be a non-empty string`,
      );
    }
    if (citedSeen.has(path)) {
      throw new Error(
        `decision graphEvidence.citedFeaturePaths contains duplicate ${JSON.stringify(path)}`,
      );
    }
    citedSeen.add(path);
  }

  if (
    cited.length !== expectedUnion.length ||
    cited.some((p, i) => p !== expectedUnion[i])
  ) {
    throw new Error(
      "decision graphEvidence.citedFeaturePaths must equal the deduplicated union of all signal citations (first-seen order; no filler)",
    );
  }

  return {
    action: d.action,
    confidence: d.confidence,
    liquidityPercentageToDecrease: d.liquidityPercentageToDecrease,
    summary: d.summary.trim(),
    signals: d.signals.map((signal) => {
      const s = /** @type {Record<string, unknown>} */ (signal);
      return {
        direction: /** @type {string} */ (s.direction),
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
