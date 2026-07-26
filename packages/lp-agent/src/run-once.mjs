/**
 * Multi-position LP agent pipeline.
 *
 * 1) Recover in-progress REBALANCE from local state (independent of discovery/AI)
 * 2) Discover active positions (list_v3_positions / NFT filter), skipping in-progress NFTs
 * 3) Per remaining position: get → Graph → features → pair → AI → plan → execute
 */

import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import {
  getV3Position,
  decreaseV3Position,
  createV3Position,
  listV3Positions,
  quoteTrade,
  swapTokens,
  redactSecrets,
} from "./orloj-mcp-client.mjs";
import { discoverManagedPositions } from "./discovery.mjs";
import { fetchPoolMarketContext } from "./graph-client.mjs";
import { extractFeatures } from "./features.mjs";
import {
  pairContextFromMarket,
  requirePairContextFromMarket,
  validatePairAgainstFeatures,
  requestDecision,
} from "./decision-client.mjs";
import { planAction } from "./action-planner.mjs";
import {
  loadState,
  saveState,
  getInProgressRebalance,
} from "./state-store.mjs";
import {
  executeOrObserveRebalance,
  recoverInProgressRebalance,
  finalizePositionResult,
  isSuccessfulPositionResult,
} from "./rebalance.mjs";

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
 * @property {(client: object, config: object, deps?: object) => Promise<object>} [discoverFn]
 * @property {(client: object, params: object) => Promise<unknown>} [decreasePosition]
 * @property {(client: object, params: object) => Promise<unknown>} [createPosition]
 * @property {(client: object, params: object) => Promise<unknown>} [quoteTradeFn]
 * @property {(client: object, params: object) => Promise<unknown>} [swapTokensFn]
 * @property {(client: object, params: object) => Promise<object>} [listPositions]
 * @property {(path: string) => object} [loadStateFn]
 * @property {(path: string, state: object) => void} [saveStateFn]
 */

async function evaluatePosition(args) {
  const {
    config,
    mcpClient,
    graphClient,
    aiClient,
    nftTokenId,
    discoverySource,
    getPosition,
    fetchMarket,
    extractFeaturesFn,
    requestDecisionFn,
    planActionFn,
    pairFromMarketFn,
    decreasePosition,
    createPosition,
    quoteTradeFn,
    swapTokensFn,
    state,
    saveStateFn,
    stateFilePath,
  } = args;

  // Guard: never AI-drive a position that still has in-progress rebalance state.
  const existing = getInProgressRebalance(state, nftTokenId);
  if (existing) {
    return finalizePositionResult({
      status: "needs_attention",
      phase: config.agentMode === "execute" ? 2 : 1,
      agentMode: config.agentMode,
      nftResolution: { nftTokenId, source: discoverySource },
      execution: {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: config.agentMode,
        message:
          "Position has in-progress REBALANCE state — skipped AI evaluation (recovery owns this NFT)",
        recovery: existing,
      },
    });
  }

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

  const pairRaw = pairFromMarketFn(market);
  const pair = requirePairContextFromMarket(pairRaw, market);
  validatePairAgainstFeatures(pair, features);

  const decision = await requestDecisionFn(aiClient, { features, pair });

  const plan = planActionFn(decision, {
    nftTokenId: position.nftTokenId,
    chainId: position.chainId ?? config.chainId,
    token0: position.token0,
    token1: position.token1,
    poolAddress: position.poolAddress,
  });

  const phase = config.agentMode === "execute" ? 2 : 1;

  const baseTrace = {
    phase,
    agentMode: config.agentMode,
    nftResolution: {
      nftTokenId,
      source: discoverySource,
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
    features,
    decision: {
      action: decision.action,
      confidence: decision.confidence,
      liquidityPercentageToDecrease: decision.liquidityPercentageToDecrease,
      rangeWidthBps: decision.rangeWidthBps ?? null,
      summary: decision.summary,
      signals: decision.signals,
      uncertainties: decision.uncertainties,
      graphEvidence: decision.graphEvidence,
    },
    plan,
  };

  /** @type {Record<string, unknown>} */
  let execution;

  if (plan.kind === "no_write") {
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
  } else if (plan.kind === "proposed_write") {
    if (config.agentMode !== "execute") {
      execution = {
        status: "observe",
        kind: "proposed_write",
        mode: "observe",
        message: "Dry-run complete — no MCP write performed",
        proposedCall: plan.mcpCall,
        called: null,
        mcpResponse: null,
      };
    } else {
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
    }
  } else if (plan.kind === "rebalance") {
    execution = await executeOrObserveRebalance({
      config,
      mcpClient,
      plan,
      position,
      pair,
      decreasePosition,
      createPosition,
      quoteTrade: quoteTradeFn,
      swapTokens: swapTokensFn,
      state,
      saveStateFn,
      stateFilePath,
    });
  } else {
    throw new Error(`unsupported plan kind ${JSON.stringify(plan.kind)}`);
  }

  return finalizePositionResult({
    status: "ok",
    ...baseTrace,
    execution,
  });
}

/**
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
  const discoverFn = deps.discoverFn ?? discoverManagedPositions;
  const decreasePosition = deps.decreasePosition ?? decreaseV3Position;
  const createPosition = deps.createPosition ?? createV3Position;
  const quoteTradeFn = deps.quoteTradeFn ?? quoteTrade;
  const swapTokensFn = deps.swapTokensFn ?? swapTokens;
  const listPositions = deps.listPositions ?? listV3Positions;
  const loadStateFn = deps.loadStateFn ?? loadState;
  const saveStateFn = deps.saveStateFn ?? saveState;

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

  const state = loadStateFn(config.stateFilePath);
  const phase = config.agentMode === "execute" ? 2 : 1;

  /** @type {object[]} */
  const results = [];
  /** @type {Set<string>} */
  const skipFromDiscovery = new Set();

  // 1) Recovery first — independent of discovery filtering / AI REBALANCE choice.
  for (const oldNft of Object.keys(state.inProgress ?? {})) {
    skipFromDiscovery.add(oldNft);
    const record = state.inProgress[oldNft];
    try {
      const recovered = await recoverInProgressRebalance({
        config,
        mcpClient,
        record,
        state,
        saveStateFn,
        stateFilePath: config.stateFilePath,
        createPosition,
        listPositions,
        quoteTrade: quoteTradeFn,
        swapTokens: swapTokensFn,
      });
      results.push(finalizePositionResult(recovered));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        status: "error",
        phase,
        agentMode: config.agentMode,
        nftResolution: { nftTokenId: oldNft, source: "state_in_progress" },
        message: redactSecrets(message, config.orlojMcpApiKey),
        error: redactSecrets(message, config.orlojMcpApiKey),
      });
    }
  }

  // 2) Discover active positions (may omit zero-liquidity NFTs — recovery already handled them).
  const discovery = await discoverFn(mcpClient, {
    chainId: config.chainId,
    nftTokenId: config.nftTokenId,
  });

  const toEvaluate = discovery.positions.filter(
    (p) => !skipFromDiscovery.has(p.nftTokenId),
  );

  for (const discovered of toEvaluate) {
    try {
      const result = await evaluatePosition({
        config,
        mcpClient,
        graphClient,
        aiClient,
        nftTokenId: discovered.nftTokenId,
        discoverySource: discovery.source,
        getPosition,
        fetchMarket,
        extractFeaturesFn,
        requestDecisionFn,
        planActionFn,
        pairFromMarketFn,
        decreasePosition,
        createPosition,
        quoteTradeFn,
        swapTokensFn,
        state,
        saveStateFn,
        stateFilePath: config.stateFilePath,
      });
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const redacted = redactSecrets(message, config.orlojMcpApiKey);
      if (err && typeof err === "object" && "auditTrace" in err) {
        const audit = /** @type {any} */ (err).auditTrace;
        // Attach base fields if rebalance threw partial auditTrace.
        results.push(
          finalizePositionResult({
            status: "error",
            phase,
            agentMode: config.agentMode,
            nftResolution: {
              nftTokenId: discovered.nftTokenId,
              source: discovery.source,
            },
            ...audit,
          }),
        );
      } else {
        results.push({
          status: "error",
          phase,
          agentMode: config.agentMode,
          nftResolution: {
            nftTokenId: discovered.nftTokenId,
            source: discovery.source,
          },
          message: redacted,
          error: redacted,
        });
      }
    }
  }

  const okCount = results.filter((r) => isSuccessfulPositionResult(r)).length;
  const errCount = results.length - okCount;
  /** @type {"ok"|"partial"|"error"} */
  let status = "ok";
  if (errCount > 0 && okCount > 0) status = "partial";
  else if (errCount > 0) status = "error";

  return {
    status,
    phase,
    agentMode: config.agentMode,
    discovery: {
      source: discovery.source,
      truncated: discovery.truncated,
      count: discovery.count,
      totalOwned: discovery.totalOwned,
      nftTokenIds: discovery.nftTokenIds,
      skippedForRecovery: [...skipFromDiscovery],
    },
    results,
  };
}

async function main() {
  try {
    const trace = await runOnce();
    console.log(JSON.stringify(trace, null, 2));
    if (trace.status === "error" || trace.status === "partial") {
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err && typeof err === "object" && "auditTrace" in err) {
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
