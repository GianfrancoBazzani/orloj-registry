/**
 * REBALANCE execute + recovery (fail-closed, no blind retries).
 *
 * Flow: decrease → optional swap (single-sided principal) → create.
 * Recovery runs independently of discovery/AI (zero-liquidity NFTs still resume).
 */

import { DEFAULT_CHAIN_ID } from "./config.mjs";
import { redactSecrets } from "./orloj-mcp-client.mjs";
import {
  planRebalanceFunding,
  budgetsAfterSwapQuote,
  parseQuoteOutputAmount,
  validateCreateSuccessResponse,
  validateSwapSuccessResponse,
} from "./amounts.mjs";
import {
  getInProgressRebalance,
  upsertInProgressRebalance,
  clearInProgressRebalance,
  newCycleId,
} from "./state-store.mjs";

/**
 * @param {object} record
 * @returns {boolean}
 */
export function decreaseIsNonterminal(record) {
  const st = record?.decrease?.status;
  return st === "pending" || st === "failed";
}

/**
 * @param {object} record
 * @returns {boolean}
 */
export function swapIsNonterminal(record) {
  const st = record?.swap?.status;
  return st === "pending" || st === "failed";
}

/**
 * @param {object} record
 */
export function createNeedsAttention(record) {
  const st = record?.create?.status;
  return (
    record?.decrease?.status === "succeeded" &&
    st !== "succeeded" &&
    st !== undefined
  );
}

/**
 * Attempt to adopt a new NFT via list_v3_positions after decrease (no auto-mint).
 * @returns {{ ok: true, newNftTokenId: string } | { ok: false, reason: string, candidates?: string[] }}
 */
export function reconcileCreateFromListedPositions(listed, record) {
  if (!listed || !Array.isArray(listed.positions)) {
    return { ok: false, reason: "list_positions_unavailable" };
  }
  const pool = String(record.poolAddress || "").toLowerCase();
  const oldId = String(record.oldNftTokenId);
  /** @type {string[]} */
  const candidates = [];
  for (const p of listed.positions) {
    if (!p || typeof p !== "object") continue;
    const id = /** @type {any} */ (p).nftTokenId;
    const liq = /** @type {any} */ (p).liquidity;
    const pPool = String(/** @type {any} */ (p).poolAddress || "").toLowerCase();
    if (typeof id !== "string") continue;
    if (id === oldId) continue;
    if (pool && pPool && pPool !== pool) continue;
    if (typeof liq === "string" && liq === "0") continue;
    candidates.push(id);
  }
  if (candidates.length === 1) {
    return { ok: true, newNftTokenId: candidates[0] };
  }
  return {
    ok: false,
    reason:
      candidates.length === 0
        ? "no_replacement_nft_found_on_pool"
        : "ambiguous_replacement_nfts",
    candidates,
  };
}

/**
 * Process one in-progress record without AI / without depending on discovery.
 */
export async function recoverInProgressRebalance(args) {
  const {
    config,
    mcpClient,
    record,
    state,
    saveStateFn,
    stateFilePath,
    createPosition,
    listPositions,
    quoteTrade,
    swapTokens,
  } = args;

  const base = {
    phase: config.agentMode === "execute" ? 2 : 1,
    agentMode: config.agentMode,
    kind: "rebalance_recovery",
    nftResolution: {
      nftTokenId: record.oldNftTokenId,
      source: "state_in_progress",
    },
    recovery: record,
  };

  if (config.agentMode !== "execute") {
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "observe",
        message:
          "In-progress REBALANCE present in state — observe will not mutate; resume with AGENT_MODE=execute after reconciliation",
        recovery: record,
      },
    };
  }

  // Uncertain decrease — never withdraw again.
  if (decreaseIsNonterminal(record)) {
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "execute",
        message:
          `In-progress REBALANCE has nonterminal decrease.status=${record.decrease?.status} — will not decrease again. Reconcile on-chain (get_v3_position / explorer) before clearing or retrying with operator approval.`,
        recovery: record,
      },
    };
  }

  if (record.decrease?.status !== "succeeded") {
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "execute",
        message: `Unexpected decrease.status=${JSON.stringify(record.decrease?.status)}`,
        recovery: record,
      },
    };
  }

  // Uncertain swap — never re-swap blindly.
  if (record.swap && swapIsNonterminal(record)) {
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "execute",
        message:
          `In-progress REBALANCE has nonterminal swap.status=${record.swap.status} — will not swap again. Reconcile balances/tx before operator-approved retry.`,
        recovery: record,
      },
    };
  }

  if (record.create?.status === "succeeded" && record.newNftTokenId) {
    clearInProgressRebalance(state, record.oldNftTokenId);
    saveStateFn(stateFilePath, state);
    return {
      status: "ok",
      ...base,
      execution: {
        status: "executed",
        mode: "execute",
        message: "REBALANCE already completed (cleared stale state)",
        newNftTokenId: record.newNftTokenId,
      },
    };
  }

  // Prefer list reconciliation over auto-create (mint may have succeeded with lost response).
  if (typeof listPositions === "function") {
    try {
      const listed = await listPositions(mcpClient, { chainId: config.chainId });
      const reconciled = reconcileCreateFromListedPositions(listed, record);
      if (reconciled.ok) {
        record.create = {
          status: "succeeded",
          newNftTokenId: reconciled.newNftTokenId,
          note: "reconciled_via_list_v3_positions",
        };
        record.newNftTokenId = reconciled.newNftTokenId;
        upsertInProgressRebalance(state, record);
        clearInProgressRebalance(state, record.oldNftTokenId);
        saveStateFn(stateFilePath, state);
        return {
          status: "ok",
          ...base,
          execution: {
            status: "executed",
            mode: "execute",
            message: "REBALANCE create reconciled via list_v3_positions (no remint)",
            newNftTokenId: reconciled.newNftTokenId,
            reconciliation: "list_v3_positions",
          },
        };
      }
      // Keep candidates on the recovery object for operators.
      record.reconciliation = reconciled;
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      record.reconciliation = {
        ok: false,
        reason: redactSecrets(raw, config.orlojMcpApiKey),
      };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
    }
  }

  if (!config.allowCreateRetry) {
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "execute",
        message:
          "Decrease succeeded but create is not confirmed. Will not auto-remint (duplicate risk). Reconcile via list_v3_positions or set LP_AGENT_ALLOW_CREATE_RETRY=true for an explicit operator-approved create retry.",
        recovery: record,
        reconciliation: record.reconciliation ?? null,
      },
    };
  }

  // Explicit operator-approved create retry only when budgets are known (two-sided or post-swap).
  const budgets = record.decrease?.budgets;
  if (!budgets) {
    // May still need swap before create — only if swap not done and funding plan stored.
    if (record.funding?.kind === "needs_swap" && record.swap?.status !== "succeeded") {
      return {
        status: "needs_attention",
        ...base,
        execution: {
          status: "needs_reconciliation",
          mode: "execute",
          message:
            "Operator create retry requested but swap leg not confirmed — reconcile swap first; will not auto-swap from recovery without confirmed prior quote/budgets in state",
          recovery: record,
        },
      };
    }
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reopen",
        mode: "execute",
        message:
          "Operator create retry requested but create budgets unknown — manual reopen required",
        recovery: record,
      },
    };
  }

  return await executeCreateOnly({
    config,
    mcpClient,
    record,
    state,
    saveStateFn,
    stateFilePath,
    createPosition,
    base,
  });
}

async function executeCreateOnly(args) {
  const {
    config,
    mcpClient,
    record,
    state,
    saveStateFn,
    stateFilePath,
    createPosition,
    base,
  } = args;
  const budgets = record.decrease.budgets;
  const createArgs = {
    chainId: DEFAULT_CHAIN_ID,
    tokenA: budgets.tokenA,
    tokenB: budgets.tokenB,
    maxTokenAAmount: budgets.maxTokenAAmount,
    maxTokenBAmount: budgets.maxTokenBAmount,
    rangeWidthBps: record.rangeWidthBps,
    poolAddress: record.poolAddress,
  };
  record.create = { status: "pending" };
  upsertInProgressRebalance(state, record);
  saveStateFn(stateFilePath, state);

  try {
    const createResp = await createPosition(mcpClient, createArgs);
    const validated = validateCreateSuccessResponse(createResp);
    if (!validated.ok) {
      record.create = {
        status: "failed",
        error: validated.reason,
        mcpResponse: createResp,
      };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_attention",
        ...base,
        execution: {
          status: "needs_reconciliation",
          mode: "execute",
          message: `Create returned but failed strict validation (${validated.reason}) — state not cleared; reconcile via list_v3_positions`,
          recovery: record,
          mcpResponse: createResp,
        },
      };
    }
    record.create = {
      status: "succeeded",
      hash: validated.hash,
      newNftTokenId: validated.nftTokenId,
      mcpResponse: createResp,
    };
    record.newNftTokenId = validated.nftTokenId;
    upsertInProgressRebalance(state, record);
    clearInProgressRebalance(state, record.oldNftTokenId);
    saveStateFn(stateFilePath, state);
    return {
      status: "ok",
      ...base,
      execution: {
        status: "executed",
        mode: "execute",
        message: "REBALANCE create completed (operator-approved retry)",
        newNftTokenId: validated.nftTokenId,
        called: { create: createArgs },
        mcpResponse: { create: createResp },
      },
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(raw, config.orlojMcpApiKey);
    record.create = { status: "failed", error: message };
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
    return {
      status: "needs_attention",
      ...base,
      execution: {
        status: "needs_reconciliation",
        mode: "execute",
        message: `Operator-approved create retry failed: ${message}`,
        error: message,
        recovery: record,
      },
    };
  }
}

/**
 * Fresh or plan-driven REBALANCE execute/observe (AI path).
 */
export async function executeOrObserveRebalance(args) {
  const {
    config,
    mcpClient,
    plan,
    position,
    pair,
    decreasePosition,
    createPosition,
    quoteTrade,
    swapTokens,
    state,
    saveStateFn,
    stateFilePath,
  } = args;

  const decreaseStep = plan.steps.find((s) => s.toolName === "decrease_v3_position");
  const createStep = plan.steps.find((s) => s.toolName === "create_v3_position");
  if (!decreaseStep || !createStep) {
    throw new Error("REBALANCE plan missing decrease/create steps");
  }

  if (config.agentMode !== "execute") {
    return {
      status: "observe",
      kind: "rebalance",
      mode: "observe",
      message:
        "Dry-run complete — REBALANCE proposes decrease → optional swap → create; no MCP write",
      proposedSteps: plan.steps,
      called: null,
      mcpResponse: null,
    };
  }

  const existing = getInProgressRebalance(state, position.nftTokenId);
  if (existing) {
    // Never start a fresh decrease while state exists — recovery owns the path.
    if (decreaseIsNonterminal(existing) || swapIsNonterminal(existing)) {
      return {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: "execute",
        message:
          "Existing in-progress REBALANCE with nonterminal decrease/swap — refusing new withdrawal/swap",
        recovery: existing,
      };
    }
    if (existing.decrease?.status === "succeeded") {
      return {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: "execute",
        message:
          "Existing in-progress REBALANCE after successful decrease — use recovery path (no AI remint). Set LP_AGENT_ALLOW_CREATE_RETRY=true only after reconciliation.",
        recovery: existing,
      };
    }
  }

  const cycleId = newCycleId();
  const rangeWidthBps = createStep.arguments.rangeWidthBps;
  /** @type {import("./state-store.mjs").InProgressRebalance} */
  let record = {
    cycleId,
    oldNftTokenId: position.nftTokenId,
    poolAddress: position.poolAddress,
    token0: position.token0,
    token1: position.token1,
    liquidityPercentageToDecrease:
      decreaseStep.arguments.liquidityPercentageToDecrease,
    rangeWidthBps: /** @type {number} */ (rangeWidthBps),
    decrease: { status: "pending", budgets: null },
    swap: { status: "pending" },
    create: { status: "pending" },
    newNftTokenId: null,
    updatedAt: new Date().toISOString(),
  };
  upsertInProgressRebalance(state, record);
  saveStateFn(stateFilePath, state);

  let decreaseResp;
  try {
    decreaseResp = await decreasePosition(mcpClient, {
      chainId: decreaseStep.arguments.chainId,
      nftTokenId: decreaseStep.arguments.nftTokenId,
      liquidityPercentageToDecrease:
        decreaseStep.arguments.liquidityPercentageToDecrease,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(raw, config.orlojMcpApiKey);
    // Leave status=failed (nonterminal for retry purposes) — do not auto-retry.
    record.decrease = { status: "failed", error: message, budgets: null };
    record.swap = { status: "skipped" };
    record.create = { status: "skipped" };
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
    const failedExecution = {
      status: "failed",
      kind: "rebalance",
      mode: "execute",
      message: `REBALANCE decrease failed: ${message} — will not auto-retry decrease (needs_reconciliation on restart)`,
      error: message,
      called: { decrease: decreaseStep },
      mcpResponse: null,
      recovery: record,
    };
    const failure = new Error(`execute REBALANCE decrease failed: ${message}`);
    /** @type {any} */ (failure).auditTrace = {
      status: "error",
      execution: failedExecution,
    };
    throw failure;
  }

  const funding = planRebalanceFunding(decreaseResp, {
    token0: position.token0,
    token1: position.token1,
    decimals0: pair.token0.decimals,
    decimals1: pair.token1.decimals,
  });

  record.decrease = {
    status: "succeeded",
    hash:
      decreaseResp && typeof decreaseResp === "object"
        ? /** @type {any} */ (decreaseResp).hash
        : undefined,
    mcpResponse: decreaseResp,
    budgets: null,
  };
  record.funding = funding;
  upsertInProgressRebalance(state, record);
  saveStateFn(stateFilePath, state);

  if (!funding.ok) {
    record.swap = { status: "skipped" };
    record.create = { status: "skipped", error: `needs_reopen: ${funding.reason}` };
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
    return {
      status: "needs_reopen",
      kind: "rebalance",
      mode: "execute",
      message: `Decrease succeeded but reopen funding unavailable (${funding.reason})`,
      called: { decrease: decreaseStep },
      mcpResponse: { decrease: decreaseResp },
      recovery: record,
      budgetReason: funding.reason,
    };
  }

  /** @type {{ tokenA: string, tokenB: string, maxTokenAAmount: string, maxTokenBAmount: string }} */
  let budgets;
  /** @type {unknown} */
  let swapResp = null;
  /** @type {unknown} */
  let quoteResp = null;

  if (funding.kind === "two_sided") {
    record.swap = { status: "skipped", reason: "two_sided_principal" };
    budgets = {
      tokenA: funding.tokenA,
      tokenB: funding.tokenB,
      maxTokenAAmount: funding.maxTokenAAmount,
      maxTokenBAmount: funding.maxTokenBAmount,
    };
    record.decrease.budgets = budgets;
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
  } else {
    // needs_swap
    const swapPlan = funding.swap;
    record.swap = {
      status: "pending",
      tokenIn: swapPlan.tokenIn,
      tokenOut: swapPlan.tokenOut,
      amountInRaw: swapPlan.amountInRaw,
    };
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);

    try {
      quoteResp = await quoteTrade(mcpClient, {
        chainId: DEFAULT_CHAIN_ID,
        tokenIn: swapPlan.tokenIn,
        tokenOut: swapPlan.tokenOut,
        amount: swapPlan.amountInRaw,
        type: "EXACT_INPUT",
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = redactSecrets(raw, config.orlojMcpApiKey);
      record.swap = { status: "failed", error: `quote_failed: ${message}` };
      record.create = { status: "skipped" };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reopen",
        kind: "rebalance",
        mode: "execute",
        message: `Decrease succeeded; swap quote failed (${message}) — funds withdrawn; needs_reopen`,
        called: { decrease: decreaseStep, swap: null },
        mcpResponse: { decrease: decreaseResp, quote: null },
        recovery: record,
      };
    }

    const parsedQuote = parseQuoteOutputAmount(quoteResp);
    if (!parsedQuote.ok) {
      record.swap = { status: "failed", error: parsedQuote.reason, quote: quoteResp };
      record.create = { status: "skipped" };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reopen",
        kind: "rebalance",
        mode: "execute",
        message: `Decrease succeeded; swap quote unusable (${parsedQuote.reason})`,
        recovery: record,
        mcpResponse: { decrease: decreaseResp, quote: quoteResp },
      };
    }

    const postSwapBudgets = budgetsAfterSwapQuote({
      surplusSide: swapPlan.surplusSide,
      remainingSurplusRaw: swapPlan.remainingSurplusRaw,
      amountOutRaw: parsedQuote.amountOutRaw,
      decimals0: pair.token0.decimals,
      decimals1: pair.token1.decimals,
      token0: position.token0,
      token1: position.token1,
    });
    if (!postSwapBudgets.ok) {
      record.swap = { status: "failed", error: postSwapBudgets.reason, quote: quoteResp };
      record.create = { status: "skipped" };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reopen",
        kind: "rebalance",
        mode: "execute",
        message: `Decrease succeeded; could not build post-swap budgets (${postSwapBudgets.reason})`,
        recovery: record,
      };
    }

    // Persist intended budgets before broadcasting swap (crash → needs_reconciliation, not re-swap).
    record.decrease.budgets = {
      tokenA: postSwapBudgets.tokenA,
      tokenB: postSwapBudgets.tokenB,
      maxTokenAAmount: postSwapBudgets.maxTokenAAmount,
      maxTokenBAmount: postSwapBudgets.maxTokenBAmount,
    };
    record.swap.quote = quoteResp;
    record.swap.amountOutRaw = parsedQuote.amountOutRaw;
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);

    try {
      swapResp = await swapTokens(mcpClient, {
        chainId: DEFAULT_CHAIN_ID,
        tokenIn: swapPlan.tokenIn,
        tokenOut: swapPlan.tokenOut,
        amount: swapPlan.amountInRaw,
        type: "EXACT_INPUT",
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = redactSecrets(raw, config.orlojMcpApiKey);
      record.swap = {
        ...record.swap,
        status: "failed",
        error: message,
      };
      record.create = { status: "skipped" };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: "execute",
        message: `Swap failed after decrease (${message}) — will not auto-retry swap; reconcile balances`,
        recovery: record,
        mcpResponse: { decrease: decreaseResp, quote: quoteResp, swap: null },
      };
    }

    const swapOk = validateSwapSuccessResponse(swapResp);
    if (!swapOk.ok) {
      record.swap = {
        ...record.swap,
        status: "failed",
        error: swapOk.reason,
        mcpResponse: swapResp,
      };
      record.create = { status: "skipped" };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: "execute",
        message: `Swap response invalid (${swapOk.reason}) — may have broadcast; will not re-swap`,
        recovery: record,
        mcpResponse: { decrease: decreaseResp, swap: swapResp },
      };
    }

    record.swap = {
      ...record.swap,
      status: "succeeded",
      hash: swapOk.hash,
      mcpResponse: swapResp,
    };
    budgets = record.decrease.budgets;
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
  }

  const createArgs = {
    chainId: DEFAULT_CHAIN_ID,
    tokenA: budgets.tokenA,
    tokenB: budgets.tokenB,
    maxTokenAAmount: budgets.maxTokenAAmount,
    maxTokenBAmount: budgets.maxTokenBAmount,
    rangeWidthBps: /** @type {number} */ (rangeWidthBps),
    poolAddress: position.poolAddress,
  };

  record.create = { status: "pending" };
  upsertInProgressRebalance(state, record);
  saveStateFn(stateFilePath, state);

  try {
    const createResp = await createPosition(mcpClient, createArgs);
    const validated = validateCreateSuccessResponse(createResp);
    if (!validated.ok) {
      record.create = {
        status: "failed",
        error: validated.reason,
        mcpResponse: createResp,
      };
      upsertInProgressRebalance(state, record);
      saveStateFn(stateFilePath, state);
      return {
        status: "needs_reconciliation",
        kind: "rebalance",
        mode: "execute",
        message: `Create response failed validation (${validated.reason}) — state retained; reconcile via list_v3_positions (do not assume remint is safe)`,
        recovery: record,
        called: { decrease: decreaseStep, swap: swapResp ? true : "skipped", create: createArgs },
        mcpResponse: { decrease: decreaseResp, swap: swapResp, create: createResp },
      };
    }
    record.create = {
      status: "succeeded",
      hash: validated.hash,
      newNftTokenId: validated.nftTokenId,
      mcpResponse: createResp,
    };
    record.newNftTokenId = validated.nftTokenId;
    upsertInProgressRebalance(state, record);
    clearInProgressRebalance(state, position.nftTokenId);
    saveStateFn(stateFilePath, state);
    return {
      status: "executed",
      kind: "rebalance",
      mode: "execute",
      message:
        funding.kind === "needs_swap"
          ? "REBALANCE decrease+swap+create executed via Orloj MCP"
          : "REBALANCE decrease+create executed via Orloj MCP",
      newNftTokenId: validated.nftTokenId,
      called: { decrease: decreaseStep, swap: swapResp ? true : "skipped", create: createArgs },
      mcpResponse: { decrease: decreaseResp, quote: quoteResp, swap: swapResp, create: createResp },
      note: "create budgets use decrease principal and optional quoted swap output haircut; fees not assumed",
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(raw, config.orlojMcpApiKey);
    record.create = { status: "failed", error: message };
    upsertInProgressRebalance(state, record);
    saveStateFn(stateFilePath, state);
    const failedExecution = {
      status: "failed",
      kind: "rebalance",
      mode: "execute",
      message: `REBALANCE create failed after successful decrease: ${message} — will not auto-remint`,
      error: message,
      recovery: record,
      called: { decrease: decreaseStep, swap: swapResp ? true : "skipped", create: createArgs },
      mcpResponse: { decrease: decreaseResp, swap: swapResp, create: null },
    };
    const failure = new Error(`execute REBALANCE create failed: ${message}`);
    /** @type {any} */ (failure).auditTrace = {
      status: "error",
      execution: failedExecution,
    };
    throw failure;
  }
}

/**
 * Normalize execution statuses that require operator attention into result.status.
 * @param {object} result
 */
export function finalizePositionResult(result) {
  const execStatus = result?.execution?.status;
  if (
    execStatus === "needs_reopen" ||
    execStatus === "needs_reconciliation" ||
    execStatus === "failed"
  ) {
    return {
      ...result,
      status: result.status === "error" ? "error" : "needs_attention",
    };
  }
  return result;
}

/**
 * @param {object} result
 */
export function isSuccessfulPositionResult(result) {
  return result?.status === "ok";
}
