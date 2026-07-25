/**
 * Single-run LP agent pipeline.
 *
 * Phase 1 observe: dry-run audit trace (no MCP write).
 * Phase 2 execute: HOLD never writes; REDUCE calls decrease_v3_position exactly once.
 *
 * Invariants:
 * - pairContextFromMarket(market) must be non-null (ids, symbols, decimals, fee tier).
 * - Pair is validated against features.position before requestDecision.
 * - Never falls back to address-only pair context.
 * - HOLD → no write; REDUCE → hardcoded decrease_v3_position only.
 * - Execute MCP failures fail closed (never silently downgraded to observe).
 */

import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import {
  getV3Position,
  decreaseV3Position,
  resolveManagedNftTokenId,
  redactSecrets,
} from "./orloj-mcp-client.mjs";
import { fetchPoolMarketContext } from "./graph-client.mjs";
import { extractFeatures } from "./features.mjs";
import {
  pairContextFromMarket,
  requirePairContextFromMarket,
  validatePairAgainstFeatures,
  requestDecision,
} from "./decision-client.mjs";
import { planAction } from "./action-planner.mjs";

/**
 * @typedef {object} RunOnceDeps
 * @property {ReturnType<typeof loadConfig>} [config]
 * @property {typeof fetch} [fetchImpl]
 * @property {(client: object, params: object) => Promise<object>} [getPosition]
 * @property {(client: object, params: object) => Promise<object>} [fetchMarket]
 * @property {(position: object, market: object, opts?: object) => object} [extractFeaturesFn]
 * @property {(client: object, input: object) => Promise<object>} [requestDecisionFn]
 * @property {(decision: object, context: object) => object} [planActionFn]
 * @property {(market: object) => object | null} [pairFromMarketFn]
 * @property {(client: object, config: object, deps?: object) => Promise<{ nftTokenId: string, source: string }>} [resolveNftFn]
 * @property {(client: object, params: object) => Promise<unknown>} [decreasePosition]
 */

/**
 * Run one observe/propose/(optional execute) cycle and return an audit trace (no secrets).
 * @param {RunOnceDeps} [deps]
 */
export async function runOnce(deps = {}) {
  const config = deps.config ?? loadConfig();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const getPosition = deps.getPosition ?? getV3Position;
  const fetchMarket = deps.fetchMarket ?? fetchPoolMarketContext;
  const extractFeaturesFn = deps.extractFeaturesFn ?? extractFeatures;
  const requestDecisionFn = deps.requestDecisionFn ?? requestDecision;
  const planActionFn = deps.planActionFn ?? planAction;
  const pairFromMarketFn = deps.pairFromMarketFn ?? pairContextFromMarket;
  const resolveNftFn = deps.resolveNftFn ?? resolveManagedNftTokenId;
  const decreasePosition = deps.decreasePosition ?? decreaseV3Position;

  const mcpClient = {
    url: config.orlojMcpUrl,
    apiKey: config.orlojMcpApiKey,
    fetchImpl,
  };
  const graphClient = {
    graphUrl: config.graphUrl,
    apiKey: config.theGraphApiKey,
    subgraphId: config.subgraphId,
    fetchImpl,
  };
  const aiClient = {
    aiChatCompletionsUrl: config.aiChatCompletionsUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    fetchImpl,
  };

  const resolvedNft = await resolveNftFn(mcpClient, {
    chainId: config.chainId,
    nftTokenId: config.nftTokenId,
  });
  const nftTokenId = resolvedNft.nftTokenId;

  const position = await getPosition(mcpClient, {
    chainId: config.chainId,
    nftTokenId,
  });

  const market = await fetchMarket(graphClient, {
    poolAddress: position.poolAddress,
  });

  const features = extractFeaturesFn(position, market, {
    expectedNftTokenId: nftTokenId,
  });

  // Fail closed: never silently fall back to address-only pair context.
  const pairRaw = pairFromMarketFn(market);
  const pair = requirePairContextFromMarket(pairRaw, market);
  validatePairAgainstFeatures(pair, features);

  const decision = await requestDecisionFn(aiClient, { features, pair });

  const plan = planActionFn(decision, {
    nftTokenId: position.nftTokenId,
    chainId: position.chainId ?? config.chainId,
  });

  const phase = config.agentMode === "execute" ? 2 : 1;

  /** Audit envelope shared by success and execute-failure paths. */
  const baseTrace = {
    phase,
    agentMode: config.agentMode,
    nftResolution: {
      nftTokenId,
      source: resolvedNft.source,
    },
    position: {
      nftTokenId: position.nftTokenId,
      chainId: position.chainId,
      poolAddress: position.poolAddress,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      fee: position.fee,
      token0: position.token0,
      token1: position.token1,
    },
    pair: {
      token0: {
        id: pair.token0.id,
        symbol: pair.token0.symbol,
        decimals: pair.token0.decimals,
      },
      token1: {
        id: pair.token1.id,
        symbol: pair.token1.symbol,
        decimals: pair.token1.decimals,
      },
      feeTier: pair.feeTier,
    },
    graph: {
      subgraphId: features.graph?.subgraphId,
      indexedBlock: features.graph?.indexedBlock,
      ageSeconds: features.graph?.ageSeconds,
      missingInputFlags: features.missingInputFlags,
      usdDataUsable: features.usdDataUsable,
    },
    decision: {
      action: decision.action,
      confidence: decision.confidence,
      liquidityPercentageToDecrease: decision.liquidityPercentageToDecrease,
      summary: decision.summary,
      signals: decision.signals,
      uncertainties: decision.uncertainties,
      graphEvidence: decision.graphEvidence,
    },
    plan,
  };

  /** @type {Record<string, unknown>} */
  let execution;
  if (plan.kind === "no_write" || plan.mcpCall === null) {
    // HOLD: never write — even in execute mode.
    execution = {
      status: config.agentMode === "execute" ? "held" : "observe",
      kind: "no_write",
      mode: config.agentMode,
      message:
        config.agentMode === "execute"
          ? "HOLD — no write planned; nothing executed"
          : "Dry-run complete — HOLD; no MCP write performed",
      proposedCall: null,
      wouldCall: null,
      called: null,
      mcpResponse: null,
    };
  } else if (config.agentMode === "execute") {
    // Phase 2: actually call decrease_v3_position exactly once with plan args.
    let mcpResponse;
    try {
      mcpResponse = await decreasePosition(mcpClient, {
        chainId: plan.mcpCall.arguments.chainId,
        nftTokenId: plan.mcpCall.arguments.nftTokenId,
        liquidityPercentageToDecrease:
          plan.mcpCall.arguments.liquidityPercentageToDecrease,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = redactSecrets(raw, config.orlojMcpApiKey);
      const failedExecution = {
        status: "failed",
        kind: "proposed_write",
        mode: "execute",
        message: `MCP write failed: ${message}`,
        called: plan.mcpCall,
        mcpResponse: null,
        error: message,
      };
      // Fail closed — full audit-complete trace (not observe downgrade).
      const failure = new Error(`execute decrease_v3_position failed: ${message}`);
      /** @type {any} */ (failure).auditTrace = {
        status: "error",
        ...baseTrace,
        execution: failedExecution,
      };
      /** @type {any} */ (failure).execution = failedExecution;
      throw failure;
    }

    execution = {
      status: "executed",
      kind: "proposed_write",
      mode: "execute",
      message: "decrease_v3_position executed via Orloj MCP",
      called: plan.mcpCall,
      mcpResponse,
    };
  } else {
    execution = {
      status: "observe",
      kind: "proposed_write",
      mode: "observe",
      message: "Dry-run complete — no MCP write performed",
      proposedCall: plan.mcpCall,
      called: null,
      mcpResponse: null,
    };
  }

  return {
    status: "ok",
    ...baseTrace,
    execution,
  };
}

async function main() {
  try {
    const trace = await runOnce();
    console.log(JSON.stringify(trace, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err && typeof err === "object" && "auditTrace" in err) {
      // Audit-complete failed execute: full envelope already built.
      console.error(JSON.stringify(/** @type {any} */ (err).auditTrace, null, 2));
    } else {
      console.error(
        JSON.stringify({
          status: "error",
          phase: 2,
          message,
        }),
      );
    }
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await main();
}
