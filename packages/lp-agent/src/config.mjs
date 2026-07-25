/**
 * Environment configuration for the LP agent.
 * Phase 1: load from process.env only (no dotenv dependency).
 * Implemented in T3.
 */

export const DEFAULT_SUBGRAPH_ID =
  "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR";

export const DEFAULT_GRAPH_GATEWAY_BASE =
  "https://gateway.thegraph.com/api/subgraphs/id";

export const DEFAULT_CHAIN_ID = "11155111";

/**
 * @returns {never}
 */
export function loadConfig() {
  throw new Error("loadConfig is not implemented yet (T3)");
}
