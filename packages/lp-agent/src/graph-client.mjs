/**
 * The Graph client for Uniswap V3 Sepolia market context.
 * Live schema fields finalized after T1; runtime queries after T4.
 * Fail closed on stale indexing / indexing errors / missing essential pool data.
 * Sparse hour/swap rows with fresh _meta are valid (inactive market).
 */

/**
 * @returns {never}
 */
export async function fetchPoolMarketContext() {
  throw new Error("fetchPoolMarketContext is not implemented yet (T4; requires T1)");
}
