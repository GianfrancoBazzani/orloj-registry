/**
 * Convert Uniswap raw base-unit amounts to human decimals and plan REBALANCE funding.
 * Decrease principal may be single-sided (out-of-range); create requires both max amounts > 0,
 * so a conservative swap leg may be required before reopen.
 */

/** Fraction of quoted swap output to use as create budget (integer basis points). */
export const SWAP_OUTPUT_BUDGET_BPS = 9900; // 99%

/**
 * @param {string} rawUnsignedDecimal integer base units as decimal string
 * @param {number} decimals token decimals (0–255)
 * @returns {string} human decimal (no trailing zeros after point)
 */
export function formatHumanAmount(rawUnsignedDecimal, decimals) {
  if (typeof rawUnsignedDecimal !== "string" || !/^\d+$/.test(rawUnsignedDecimal)) {
    throw new Error(
      `formatHumanAmount raw must be an unsigned decimal integer string (got ${JSON.stringify(rawUnsignedDecimal)})`,
    );
  }
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    throw new Error(`formatHumanAmount decimals must be an integer 0–255 (got ${decimals})`);
  }
  if (decimals === 0) {
    return rawUnsignedDecimal.replace(/^0+(?=\d)/, "") || "0";
  }

  const digits = rawUnsignedDecimal.replace(/^0+(?=\d)/, "") || "0";
  const d = decimals;
  let whole;
  let frac;
  if (digits.length > d) {
    whole = digits.slice(0, digits.length - d);
    frac = digits.slice(digits.length - d);
  } else {
    whole = "0";
    frac = digits.padStart(d, "0");
  }
  frac = frac.replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/**
 * @param {string} raw
 * @returns {string} floor(raw/2) as decimal string
 */
export function halfRawAmount(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("halfRawAmount requires an unsigned decimal integer string");
  }
  return (BigInt(raw) / 2n).toString();
}

/**
 * @param {string} raw
 * @param {number} bps 0–10000
 * @returns {string}
 */
export function scaleRawAmountBps(raw, bps) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("scaleRawAmountBps requires an unsigned decimal integer string");
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("scaleRawAmountBps bps must be integer 0–10000");
  }
  return ((BigInt(raw) * BigInt(bps)) / 10000n).toString();
}

/**
 * @param {unknown} tokenSide
 * @param {string} expectedAddress
 * @param {string} label
 * @returns {{ tokenAddress: string, amount: string }}
 */
function requireTokenSide(tokenSide, expectedAddress, label) {
  if (tokenSide === null || typeof tokenSide !== "object" || Array.isArray(tokenSide)) {
    throw new Error(`decrease ${label} must be an object`);
  }
  const t = /** @type {Record<string, unknown>} */ (tokenSide);
  if (typeof t.tokenAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t.tokenAddress)) {
    throw new Error(`decrease ${label}.tokenAddress must be a 20-byte 0x address`);
  }
  if (typeof t.amount !== "string" || !/^\d+$/.test(t.amount)) {
    throw new Error(`decrease ${label}.amount must be an unsigned decimal integer string`);
  }
  if (t.tokenAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `decrease ${label}.tokenAddress ${t.tokenAddress} does not match position ${expectedAddress}`,
    );
  }
  return { tokenAddress: t.tokenAddress, amount: t.amount };
}

/**
 * Extract quote.output.amount (raw) from Uniswap Trading API / MCP quote envelope.
 * @param {unknown} quoteResponse
 * @returns {{ ok: true, amountOutRaw: string, amountInRaw: string | null } | { ok: false, reason: string }}
 */
export function parseQuoteOutputAmount(quoteResponse) {
  if (
    quoteResponse === null ||
    typeof quoteResponse !== "object" ||
    Array.isArray(quoteResponse)
  ) {
    return { ok: false, reason: "quote_response_not_object" };
  }
  const root = /** @type {Record<string, unknown>} */ (quoteResponse);
  const quote =
    root.quote !== null && typeof root.quote === "object" && !Array.isArray(root.quote)
      ? /** @type {Record<string, unknown>} */ (root.quote)
      : root;
  const output =
    quote.output !== null && typeof quote.output === "object" && !Array.isArray(quote.output)
      ? /** @type {Record<string, unknown>} */ (quote.output)
      : null;
  const input =
    quote.input !== null && typeof quote.input === "object" && !Array.isArray(quote.input)
      ? /** @type {Record<string, unknown>} */ (quote.input)
      : null;
  const amountOut =
    output && typeof output.amount === "string"
      ? output.amount
      : typeof quote.amountOut === "string"
        ? quote.amountOut
        : null;
  if (amountOut === null || !/^\d+$/.test(amountOut) || amountOut === "0") {
    return { ok: false, reason: "quote_missing_positive_output_amount" };
  }
  const amountIn =
    input && typeof input.amount === "string" && /^\d+$/.test(input.amount)
      ? input.amount
      : null;
  return { ok: true, amountOutRaw: amountOut, amountInRaw: amountIn };
}

/**
 * Strict decrease_v3_position success gate before funding/create.
 * @param {unknown} decreaseResponse
 * @param {{
 *   nftTokenId: string,
 *   liquidityPercentageToDecrease: number,
 *   token0: string,
 *   token1: string,
 * }} expected
 * @returns {{ ok: true, hash: string } | { ok: false, reason: string }}
 */
export function validateDecreaseSuccessResponse(decreaseResponse, expected) {
  if (
    decreaseResponse === null ||
    typeof decreaseResponse !== "object" ||
    Array.isArray(decreaseResponse)
  ) {
    return { ok: false, reason: "decrease_response_not_object" };
  }
  const r = /** @type {Record<string, unknown>} */ (decreaseResponse);
  if (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) {
    return { ok: false, reason: "decrease_response_missing_valid_hash" };
  }
  if (typeof r.nftTokenId !== "string" || r.nftTokenId !== expected.nftTokenId) {
    return { ok: false, reason: "decrease_response_nftTokenId_mismatch" };
  }
  if (r.liquidityPercentageToDecrease !== expected.liquidityPercentageToDecrease) {
    return {
      ok: false,
      reason: "decrease_response_liquidityPercentageToDecrease_mismatch",
    };
  }
  try {
    requireTokenSide(r.token0, expected.token0, "token0");
    requireTokenSide(r.token1, expected.token1, "token1");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, hash: r.hash };
}

/**
 * Strict create_v3_position success gate — required before clearing rebalance state.
 * @param {unknown} createResponse
 * @returns {{ ok: true, hash: string, nftTokenId: string } | { ok: false, reason: string }}
 */
export function validateCreateSuccessResponse(createResponse) {
  if (
    createResponse === null ||
    typeof createResponse !== "object" ||
    Array.isArray(createResponse)
  ) {
    return { ok: false, reason: "create_response_not_object" };
  }
  const r = /** @type {Record<string, unknown>} */ (createResponse);
  if (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) {
    return { ok: false, reason: "create_response_missing_valid_hash" };
  }
  if (typeof r.nftTokenId !== "string" || !/^(0|[1-9]\d*)$/.test(r.nftTokenId)) {
    return { ok: false, reason: "create_response_missing_valid_nftTokenId" };
  }
  return { ok: true, hash: r.hash, nftTokenId: r.nftTokenId };
}

/**
 * Strict swap success gate (MCP swap returns hash only).
 * @param {unknown} swapResponse
 */
export function validateSwapSuccessResponse(swapResponse) {
  if (
    swapResponse === null ||
    typeof swapResponse !== "object" ||
    Array.isArray(swapResponse)
  ) {
    return { ok: false, reason: "swap_response_not_object" };
  }
  const r = /** @type {Record<string, unknown>} */ (swapResponse);
  if (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) {
    return { ok: false, reason: "swap_response_missing_valid_hash" };
  }
  return { ok: true, hash: r.hash };
}

/**
 * @param {unknown} decreaseResponse
 * @param {{
 *   token0: string,
 *   token1: string,
 *   decimals0: number | string,
 *   decimals1: number | string,
 * }} positionPair
 * @returns {{
 *   ok: true,
 *   kind: "two_sided",
 *   tokenA: string,
 *   tokenB: string,
 *   maxTokenAAmount: string,
 *   maxTokenBAmount: string,
 *   raw0: string,
 *   raw1: string,
 * } | {
 *   ok: true,
 *   kind: "needs_swap",
 *   tokenA: string,
 *   tokenB: string,
 *   raw0: string,
 *   raw1: string,
 *   swap: {
 *     tokenIn: string,
 *     tokenOut: string,
 *     amountInRaw: string,
 *     surplusSide: "token0" | "token1",
 *     remainingSurplusRaw: string,
 *   },
 * } | { ok: false, reason: string }}
 */
export function planRebalanceFunding(decreaseResponse, positionPair) {
  if (
    decreaseResponse === null ||
    typeof decreaseResponse !== "object" ||
    Array.isArray(decreaseResponse)
  ) {
    return { ok: false, reason: "decrease_response_not_object" };
  }
  const resp = /** @type {Record<string, unknown>} */ (decreaseResponse);
  let token0;
  let token1;
  try {
    token0 = requireTokenSide(resp.token0, positionPair.token0, "token0");
    token1 = requireTokenSide(resp.token1, positionPair.token1, "token1");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const d0 = Number(positionPair.decimals0);
  const d1 = Number(positionPair.decimals1);
  if (!Number.isInteger(d0) || d0 < 0 || d0 > 255 || !Number.isInteger(d1) || d1 < 0 || d1 > 255) {
    return { ok: false, reason: "invalid_decimals" };
  }

  const z0 = token0.amount === "0";
  const z1 = token1.amount === "0";
  if (z0 && z1) {
    return { ok: false, reason: "both_principal_sides_zero" };
  }

  if (!z0 && !z1) {
    try {
      const maxTokenAAmount = formatHumanAmount(token0.amount, d0);
      const maxTokenBAmount = formatHumanAmount(token1.amount, d1);
      if (maxTokenAAmount === "0" || maxTokenBAmount === "0") {
        return { ok: false, reason: "zero_human_budget" };
      }
      return {
        ok: true,
        kind: "two_sided",
        tokenA: positionPair.token0,
        tokenB: positionPair.token1,
        maxTokenAAmount,
        maxTokenBAmount,
        raw0: token0.amount,
        raw1: token1.amount,
      };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Single-sided principal — need swap leg (canonical out-of-range case).
  const surplusSide = z0 ? "token1" : "token0";
  const surplusRaw = surplusSide === "token0" ? token0.amount : token1.amount;
  const amountInRaw = halfRawAmount(surplusRaw);
  if (amountInRaw === "0") {
    return { ok: false, reason: "surplus_too_small_to_split_for_swap" };
  }
  const remainingSurplusRaw = (BigInt(surplusRaw) - BigInt(amountInRaw)).toString();
  if (remainingSurplusRaw === "0") {
    return { ok: false, reason: "remaining_surplus_zero_after_half_swap" };
  }

  return {
    ok: true,
    kind: "needs_swap",
    tokenA: positionPair.token0,
    tokenB: positionPair.token1,
    raw0: token0.amount,
    raw1: token1.amount,
    swap: {
      tokenIn: surplusSide === "token0" ? positionPair.token0 : positionPair.token1,
      tokenOut: surplusSide === "token0" ? positionPair.token1 : positionPair.token0,
      amountInRaw,
      surplusSide,
      remainingSurplusRaw,
    },
  };
}

/**
 * After quote, build create budgets from remaining surplus + haircuted amountOut.
 * @param {{
 *   surplusSide: "token0" | "token1",
 *   remainingSurplusRaw: string,
 *   amountOutRaw: string,
 *   decimals0: number | string,
 *   decimals1: number | string,
 *   token0: string,
 *   token1: string,
 * }} args
 */
export function budgetsAfterSwapQuote(args) {
  const d0 = Number(args.decimals0);
  const d1 = Number(args.decimals1);
  const outBudgetRaw = scaleRawAmountBps(args.amountOutRaw, SWAP_OUTPUT_BUDGET_BPS);
  if (outBudgetRaw === "0") {
    return { ok: false, reason: "quoted_output_haircut_to_zero" };
  }
  try {
    let raw0;
    let raw1;
    if (args.surplusSide === "token0") {
      raw0 = args.remainingSurplusRaw;
      raw1 = outBudgetRaw;
    } else {
      raw0 = outBudgetRaw;
      raw1 = args.remainingSurplusRaw;
    }
    const maxTokenAAmount = formatHumanAmount(raw0, d0);
    const maxTokenBAmount = formatHumanAmount(raw1, d1);
    if (maxTokenAAmount === "0" || maxTokenBAmount === "0") {
      return { ok: false, reason: "zero_human_budget_after_swap_quote" };
    }
    return {
      ok: true,
      tokenA: args.token0,
      tokenB: args.token1,
      maxTokenAAmount,
      maxTokenBAmount,
      raw0,
      raw1,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @deprecated prefer planRebalanceFunding — kept for two-sided-only callers
 */
export function budgetsFromDecreaseResponse(decreaseResponse, positionPair) {
  const planned = planRebalanceFunding(decreaseResponse, positionPair);
  if (!planned.ok) return planned;
  if (planned.kind === "two_sided") {
    return {
      ok: true,
      tokenA: planned.tokenA,
      tokenB: planned.tokenB,
      maxTokenAAmount: planned.maxTokenAAmount,
      maxTokenBAmount: planned.maxTokenBAmount,
      raw0: planned.raw0,
      raw1: planned.raw1,
    };
  }
  return { ok: false, reason: "zero_principal_side_cannot_fund_create" };
}
