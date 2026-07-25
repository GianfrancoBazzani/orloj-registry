/**
 * Maps a validated decision to a proposed Orloj MCP call (or none).
 * Phase 1: HOLD → no write; REDUCE_LIQUIDITY → decrease_v3_position.
 * Never plans claim immediately before/after decrease.
 * decrease_v3_position also collects accrued fees; returned amounts are principal-only.
 * Implemented in T7.
 */

/**
 * @returns {never}
 */
export function planAction() {
  throw new Error("planAction is not implemented yet (T7)");
}
