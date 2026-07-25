/**
 * Provider-neutral OpenAI-compatible chat-completions client for LP decisions.
 * No MCP calls, no execution, no silent HOLD fallback.
 */

import { redactSecrets } from "./orloj-mcp-client.mjs";
import { validateDecision } from "./decision-schema.mjs";

export const DEFAULT_AI_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} DecisionClientOptions
 * @property {string} aiChatCompletionsUrl
 * @property {string} aiApiKey
 * @property {string} aiModel
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} PairTokenInfo
 * @property {string} symbol
 * @property {string} decimals
 * @property {string} [id]
 */

/**
 * @typedef {object} PairContext
 * @property {PairTokenInfo} token0
 * @property {PairTokenInfo} token1
 * @property {string} [feeTier]
 */

const SYSTEM_PROMPT = `You are an Orloj Uniswap V3 LP risk advisor for Ethereum Sepolia.
Return ONE JSON object only — no markdown fences, no prose, no commentary.

Allowed actions (exact strings): HOLD | REDUCE_LIQUIDITY.
CLAIM_FEES and any other action are forbidden.

Required JSON shape:
{
  "action": "HOLD" | "REDUCE_LIQUIDITY",
  "confidence": number between 0 and 1,
  "liquidityPercentageToDecrease": null for HOLD; integer 1–100 for REDUCE_LIQUIDITY,
  "summary": concise non-empty string,
  "signals": nonempty array of {
    "direction": non-empty string,
    "observation": non-empty string,
    "citations": nonempty array of exact dotted feature paths from the provided features
  },
  "uncertainties": array of non-empty strings describing missing or unreliable evidence,
  "graphEvidence": {
    "subgraphId": string (must match features.graph.subgraphId),
    "indexedBlock": must match features.graph.indexedBlock,
    "ageSeconds": must match features.graph.ageSeconds,
    "citedFeaturePaths": nonempty array of exact feature paths you relied on
  }
}

Rules:
- Do not invent feature paths. Cite only paths that exist in the provided features object.
- null means insufficient evidence, while numeric zero means measured zero.
- When usdDataUsable.usable is false, ignore all USD-derived values (fees.usd_*, feeToTvl_*, tvl trends that depend on USD, etc.). Prefer ticks, raw token volumes, liquidity, and activity.
- Activity intensity is activity.txCountSum* (summed PoolHourData.txCount). Sampled swap row counts are NOT total intensity.
- Weigh Graph freshness (features.graph.ageSeconds / maxIndexedAgeSeconds), missingInputFlags, range state, volatility proxies, activity, volume trends, fee/TVL evidence when USD is usable, and liquidity trends.
- REDUCE_LIQUIDITY requires multiple independent signals (at least two signals citing distinct feature paths). Do not use a single price/range trigger alone.
- HOLD requires liquidityPercentageToDecrease null.
- Extra fields are forbidden. Invalid JSON will be rejected.`;

/**
 * Build OpenAI-compatible chat messages (no secrets).
 * @param {{ features: object, pair?: PairContext | null }} input
 */
export function buildDecisionMessages({ features, pair = null }) {
  if (!features || typeof features !== "object") {
    throw new Error("buildDecisionMessages requires features");
  }

  const pairBlock =
    pair && pair.token0 && pair.token1
      ? {
          token0: {
            id: pair.token0.id ?? features.position?.token0,
            symbol: pair.token0.symbol,
            decimals: pair.token0.decimals,
          },
          token1: {
            id: pair.token1.id ?? features.position?.token1,
            symbol: pair.token1.symbol,
            decimals: pair.token1.decimals,
          },
          feeTier: pair.feeTier ?? features.position?.fee,
        }
      : {
          token0: { id: features.position?.token0 },
          token1: { id: features.position?.token1 },
          feeTier: features.position?.fee,
          note: "token symbols/decimals unavailable — use addresses only",
        };

  const userPayload = {
    instruction:
      "Decide HOLD or REDUCE_LIQUIDITY from the features below. Reply with the JSON object only.",
    pair: pairBlock,
    features: {
      position: features.position,
      range: features.range,
      windows: features.windows,
      volatility: features.volatility,
      activity: features.activity,
      volumes: features.volumes,
      fees: features.fees,
      liquidity: features.liquidity,
      tvl: features.tvl,
      usdDataUsable: features.usdDataUsable,
      graph: features.graph,
      evidence: features.evidence,
      missingInputFlags: features.missingInputFlags,
    },
  };

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
}

/**
 * Extract assistant content from an OpenAI-compatible chat completion body.
 * Rejects malformed envelopes, non-string content, markdown fences, and prose.
 * @param {unknown} body
 * @returns {string}
 */
export function extractChatCompletionJsonText(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("AI completion envelope must be a plain object");
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  if (!Array.isArray(b.choices) || b.choices.length === 0) {
    throw new Error("AI completion envelope missing choices");
  }
  const choice0 = b.choices[0];
  if (choice0 === null || typeof choice0 !== "object" || Array.isArray(choice0)) {
    throw new Error("AI completion choices[0] must be an object");
  }
  const message = /** @type {Record<string, unknown>} */ (choice0).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("AI completion choices[0].message must be an object");
  }
  const content = /** @type {Record<string, unknown>} */ (message).content;
  if (typeof content !== "string") {
    throw new Error("AI completion message.content must be a string");
  }

  const trimmed = content.trim();
  if (trimmed === "") {
    throw new Error("AI completion message.content is empty");
  }
  if (/^```/.test(trimmed) || /```/.test(trimmed)) {
    throw new Error("AI completion must be direct JSON (markdown fences rejected)");
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("AI completion must be a single JSON object (prose rejected)");
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("AI completion is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI completion JSON must be a plain object");
  }
  // Round-trip: ensure no trailing junk beyond a single JSON value.
  // JSON.parse already consumes the full string or throws.
  return trimmed;
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function readBodyText(response, signal) {
  if (signal.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  return await Promise.race([
    response.text(),
    new Promise((_, reject) => {
      const onAbort = () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
}

/**
 * @param {unknown} err
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @param {string} [phase]
 */
function mapTransportError(err, apiKey, timeoutMs, phase) {
  const name = err && typeof err === "object" && "name" in err ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw, apiKey);
  if (name === "AbortError" || /aborted/i.test(message)) {
    return new Error(`AI request timed out after ${timeoutMs}ms`);
  }
  const prefix =
    phase === "body read" ? "AI HTTP body read failed" : "AI HTTP request failed";
  return new Error(`${prefix}: ${message}`);
}

/**
 * Request a validated LP decision from an OpenAI-compatible endpoint.
 *
 * @param {DecisionClientOptions} client
 * @param {{ features: object, pair?: PairContext | null }} input
 */
export async function requestDecision(client, input) {
  if (!client || typeof client.aiChatCompletionsUrl !== "string") {
    throw new Error("requestDecision requires client.aiChatCompletionsUrl");
  }
  if (typeof client.aiApiKey !== "string" || client.aiApiKey.trim() === "") {
    throw new Error("requestDecision requires client.aiApiKey");
  }
  if (typeof client.aiModel !== "string" || client.aiModel.trim() === "") {
    throw new Error("requestDecision requires client.aiModel");
  }
  if (!input || !input.features || typeof input.features !== "object") {
    throw new Error("requestDecision requires input.features");
  }

  const timeoutMs = client.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const messages = buildDecisionMessages({
    features: input.features,
    pair: input.pair ?? null,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(client.aiChatCompletionsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${client.aiApiKey}`,
        },
        body: JSON.stringify({
          model: client.aiModel,
          temperature: 0,
          messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw mapTransportError(err, client.aiApiKey, timeoutMs);
    }

    let rawText;
    try {
      rawText = await readBodyText(response, controller.signal);
    } catch (err) {
      throw mapTransportError(err, client.aiApiKey, timeoutMs, "body read");
    }

    const status = response.status;
    if (!response.ok) {
      const excerptRaw =
        rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
      const excerpt = redactSecrets(excerptRaw, client.aiApiKey);
      throw new Error(`AI HTTP ${status}${excerpt ? `: ${excerpt}` : ""}`);
    }

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw new Error(`AI HTTP ${status} returned invalid JSON`);
    }

    const jsonText = extractChatCompletionJsonText(body);
    let decision;
    try {
      decision = JSON.parse(jsonText);
    } catch {
      throw new Error("AI completion is not valid JSON");
    }

    // Throws on any schema / citation failure — never coerce to HOLD.
    return validateDecision(decision, input.features);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive pair context from normalized Graph market (token symbols/decimals).
 * @param {object} market
 * @returns {PairContext | null}
 */
export function pairContextFromMarket(market) {
  const t0 = market?.pool?.token0;
  const t1 = market?.pool?.token1;
  if (!t0 || !t1) return null;
  if (typeof t0.symbol !== "string" || typeof t1.symbol !== "string") return null;
  if (typeof t0.decimals !== "string" || typeof t1.decimals !== "string") return null;
  return {
    token0: { id: t0.id, symbol: t0.symbol, decimals: t0.decimals },
    token1: { id: t1.id, symbol: t1.symbol, decimals: t1.decimals },
    feeTier: market.pool?.feeTier,
  };
}
