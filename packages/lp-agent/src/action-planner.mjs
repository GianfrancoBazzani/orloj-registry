/**
 * Maps a validated decision to a proposed Orloj MCP call (or none).
 * Phase 1: HOLD → no write; REDUCE_LIQUIDITY → decrease_v3_position only.
 * Never plans claim immediately before/after decrease.
 * Tool name and argument keys are hardcoded — never taken from the model.
 * chainId is pinned to Sepolia (`11155111`).
 */

import { DEFAULT_CHAIN_ID, requireSepoliaChainId } from "./config.mjs";

export const DECREASE_V3_POSITION_TOOL = "decrease_v3_position";

/**
 * @typedef {object} ActionPlanContext
 * @property {string} nftTokenId validated Orloj/config NFT id (not AI-supplied)
 * @property {string} chainId must be Sepolia DEFAULT_CHAIN_ID
 */

/**
 * @typedef {object} NoWritePlan
 * @property {"no_write"} kind
 * @property {"HOLD"} action
 * @property {null} mcpCall
 * @property {string[]} notes
 */

/**
 * @typedef {object} ProposedWritePlan
 * @property {"proposed_write"} kind
 * @property {"REDUCE_LIQUIDITY"} action
 * @property {{ toolName: string, arguments: { chainId: string, nftTokenId: string, liquidityPercentageToDecrease: number } }} mcpCall
 * @property {string[]} notes
 */

/**
 * @param {object} decision output of validateDecision / requestDecision
 * @param {ActionPlanContext} context
 * @returns {NoWritePlan | ProposedWritePlan}
 */
export function planAction(decision, context) {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("planAction requires a validated decision object");
  }
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("planAction requires context with nftTokenId and chainId");
  }
  if (typeof context.nftTokenId !== "string" || !/^(0|[1-9]\d*)$/.test(context.nftTokenId)) {
    throw new Error(
      "planAction context.nftTokenId must be an unsigned decimal integer string",
    );
  }
  // Pin to Sepolia — reject mainnet "1" and any other chain.
  requireSepoliaChainId(context.chainId);

  // Reject any attempt to pass AI-supplied tool routing through the decision.
  if (Object.hasOwn(decision, "toolName") || Object.hasOwn(decision, "mcpCall")) {
    throw new Error(
      "planAction rejects AI-supplied toolName/mcpCall fields (tool routing is hardcoded)",
    );
  }

  if (decision.action === "HOLD") {
    if (decision.liquidityPercentageToDecrease !== null) {
      throw new Error("planAction HOLD requires liquidityPercentageToDecrease null");
    }
    return {
      kind: "no_write",
      action: "HOLD",
      mcpCall: null,
      notes: [
        "HOLD produces no write plan",
        "No MCP tool will be invoked for this decision",
      ],
    };
  }

  if (decision.action === "REDUCE_LIQUIDITY") {
    const pct = decision.liquidityPercentageToDecrease;
    if (
      typeof pct !== "number" ||
      !Number.isInteger(pct) ||
      pct < 1 ||
      pct > 100
    ) {
      throw new Error(
        "planAction REDUCE_LIQUIDITY requires liquidityPercentageToDecrease integer 1–100",
      );
    }

    return {
      kind: "proposed_write",
      action: "REDUCE_LIQUIDITY",
      mcpCall: {
        // Hardcoded tool — never from the model.
        toolName: DECREASE_V3_POSITION_TOOL,
        arguments: {
          chainId: DEFAULT_CHAIN_ID,
          nftTokenId: context.nftTokenId,
          liquidityPercentageToDecrease: pct,
        },
      },
      notes: [
        "Maps only to decrease_v3_position with validated NFT id and percentage",
        `chainId pinned to Sepolia ${DEFAULT_CHAIN_ID}`,
        "decrease_v3_position also collects accrued fees; returned amounts are principal-only",
        "Do not plan claim_v3_fees immediately before or after decrease",
      ],
    };
  }

  throw new Error(
    `planAction unsupported action ${JSON.stringify(decision.action)} (Phase 1: HOLD | REDUCE_LIQUIDITY only)`,
  );
}
