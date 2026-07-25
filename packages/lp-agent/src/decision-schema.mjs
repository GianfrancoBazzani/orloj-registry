/**
 * Strict validation of AI decision JSON.
 * Phase 1 allowed actions: HOLD | REDUCE_LIQUIDITY (CLAIM_FEES rejected).
 * Implemented in T6.
 */

export const PHASE1_ACTIONS = Object.freeze(["HOLD", "REDUCE_LIQUIDITY"]);

/**
 * @returns {never}
 */
export function validateDecision() {
  throw new Error("validateDecision is not implemented yet (T6)");
}
