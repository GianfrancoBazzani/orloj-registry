/**
 * Maps a validated decision to proposed Orloj MCP call(s) (or none).
 * HOLD → no write; REDUCE → decrease_v3_position; REBALANCE → decrease + create.
 * Never plans claim. Tool names and fund-routing args are hardcoded — never from the model.
 * chainId is pinned to Sepolia (`11155111`).
 */

import { DEFAULT_CHAIN_ID, requireSepoliaChainId } from "./config.mjs";
import {
  DEFAULT_RANGE_WIDTH_BPS,
  FORBIDDEN_AI_ROUTING_KEYS,
} from "./decision-schema.mjs";

export const DECREASE_V3_POSITION_TOOL = "decrease_v3_position";
export const CREATE_V3_POSITION_TOOL = "create_v3_position";
export const SWAP_TOOL = "swap";
export const QUOTE_TOOL = "quote";

/**
 * @typedef {object} ActionPlanContext
 * @property {string} nftTokenId validated Orloj/config NFT id (not AI-supplied)
 * @property {string} chainId must be Sepolia DEFAULT_CHAIN_ID
 * @property {string} [token0] position token0 (required for REBALANCE)
 * @property {string} [token1] position token1 (required for REBALANCE)
 * @property {string} [poolAddress] pin create to the same pool (required for REBALANCE)
 */

/**
 * @typedef {object} NoWritePlan
 * @property {"no_write"} kind
 * @property {"HOLD"} action
 * @property {null} mcpCall
 * @property {null} steps
 * @property {string[]} notes
 */

/**
 * @typedef {object} ProposedWritePlan
 * @property {"proposed_write"} kind
 * @property {"REDUCE_LIQUIDITY"} action
 * @property {{ toolName: string, arguments: Record<string, unknown> }} mcpCall
 * @property {null} steps
 * @property {string[]} notes
 */

/**
 * @typedef {object} RebalancePlan
 * @property {"rebalance"} kind
 * @property {"REBALANCE"} action
 * @property {null} mcpCall
 * @property {Array<{ toolName: string, arguments: Record<string, unknown> }>} steps
 * @property {string[]} notes
 */

/**
 * @param {object} decision output of validateDecision / requestDecision
 * @param {ActionPlanContext} context
 * @returns {NoWritePlan | ProposedWritePlan | RebalancePlan}
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
  for (const key of FORBIDDEN_AI_ROUTING_KEYS) {
    if (Object.hasOwn(decision, key)) {
      throw new Error(
        `planAction rejects AI-supplied ${key} (tool routing and addresses are hardcoded)`,
      );
    }
  }

  if (decision.action === "HOLD") {
    if (decision.liquidityPercentageToDecrease !== null) {
      throw new Error("planAction HOLD requires liquidityPercentageToDecrease null");
    }
    return {
      kind: "no_write",
      action: "HOLD",
      mcpCall: null,
      steps: null,
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
      steps: null,
      notes: [
        "Maps only to decrease_v3_position with validated NFT id and percentage",
        `chainId pinned to Sepolia ${DEFAULT_CHAIN_ID}`,
        "decrease_v3_position also collects accrued fees; returned amounts are principal-only",
        "Do not plan claim_v3_fees immediately before or after decrease",
      ],
    };
  }

  if (decision.action === "REBALANCE") {
    const pct = decision.liquidityPercentageToDecrease;
    if (
      typeof pct !== "number" ||
      !Number.isInteger(pct) ||
      pct < 1 ||
      pct > 100
    ) {
      throw new Error(
        "planAction REBALANCE requires liquidityPercentageToDecrease integer 1–100",
      );
    }
    if (typeof context.token0 !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(context.token0)) {
      throw new Error("planAction REBALANCE requires context.token0 address from position");
    }
    if (typeof context.token1 !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(context.token1)) {
      throw new Error("planAction REBALANCE requires context.token1 address from position");
    }
    if (
      typeof context.poolAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(context.poolAddress)
    ) {
      throw new Error(
        "planAction REBALANCE requires context.poolAddress from position (pool pin)",
      );
    }

    const rangeWidthBps =
      decision.rangeWidthBps === null || decision.rangeWidthBps === undefined
        ? DEFAULT_RANGE_WIDTH_BPS
        : decision.rangeWidthBps;
    if (
      typeof rangeWidthBps !== "number" ||
      !Number.isInteger(rangeWidthBps) ||
      rangeWidthBps < 1 ||
      rangeWidthBps > 9999
    ) {
      throw new Error("planAction REBALANCE rangeWidthBps must be integer 1–9999");
    }

    return {
      kind: "rebalance",
      action: "REBALANCE",
      mcpCall: null,
      steps: [
        {
          toolName: DECREASE_V3_POSITION_TOOL,
          arguments: {
            chainId: DEFAULT_CHAIN_ID,
            nftTokenId: context.nftTokenId,
            liquidityPercentageToDecrease: pct,
          },
        },
        {
          toolName: SWAP_TOOL,
          optional: true,
          arguments: {
            chainId: DEFAULT_CHAIN_ID,
            tokenIn: null,
            tokenOut: null,
            amount: null,
            type: "EXACT_INPUT",
          },
          note:
            "Executed only when decrease principal is single-sided: swap ~50% of surplus into the missing token (quote first). Skipped when both sides are positive.",
        },
        {
          toolName: CREATE_V3_POSITION_TOOL,
          arguments: {
            chainId: DEFAULT_CHAIN_ID,
            tokenA: context.token0,
            tokenB: context.token1,
            maxTokenAAmount: null,
            maxTokenBAmount: null,
            rangeWidthBps,
            poolAddress: context.poolAddress,
          },
        },
      ],
      notes: [
        "REBALANCE is a hardcoded plan: decrease_v3_position → optional swap → create_v3_position",
        "Out-of-range positions usually withdraw one-sided principal; create requires both max amounts > 0, so a conservative swap leg funds the missing side",
        "tokenA/tokenB/poolAddress/chainId/nftTokenId are taken from the Orloj position — never from the model",
        "create budgets use decrease principal (+ quoted swap output haircut); fees swept by decrease are not assumed",
        `rangeWidthBps=${rangeWidthBps} (AI may suggest; default ${DEFAULT_RANGE_WIDTH_BPS})`,
        "Do not plan claim_v3_fees",
      ],
    };
  }

  throw new Error(
    `planAction unsupported action ${JSON.stringify(decision.action)} (HOLD | REDUCE_LIQUIDITY | REBALANCE only)`,
  );
}
