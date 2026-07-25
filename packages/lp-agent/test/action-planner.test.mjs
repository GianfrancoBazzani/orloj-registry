/**
 * Decision → proposed MCP action mapping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DECREASE_V3_POSITION_TOOL,
  planAction,
} from "../src/action-planner.mjs";

const CTX = { nftTokenId: "42", chainId: "11155111" };

describe("action-planner", () => {
  it("HOLD produces no write plan", () => {
    const plan = planAction(
      {
        action: "HOLD",
        confidence: 0.5,
        liquidityPercentageToDecrease: null,
        summary: "ok",
        signals: [],
        uncertainties: [],
        graphEvidence: {},
      },
      CTX,
    );
    assert.equal(plan.kind, "no_write");
    assert.equal(plan.action, "HOLD");
    assert.equal(plan.mcpCall, null);
    assert.ok(plan.notes.some((n) => /no write/i.test(n)));
  });

  it("REDUCE maps only to decrease_v3_position with validated NFT and percentage", () => {
    const plan = planAction(
      {
        action: "REDUCE_LIQUIDITY",
        confidence: 0.9,
        liquidityPercentageToDecrease: 35,
        summary: "reduce",
        signals: [],
        uncertainties: [],
        graphEvidence: {},
      },
      CTX,
    );
    assert.equal(plan.kind, "proposed_write");
    assert.equal(plan.mcpCall.toolName, DECREASE_V3_POSITION_TOOL);
    assert.equal(plan.mcpCall.toolName, "decrease_v3_position");
    assert.deepEqual(plan.mcpCall.arguments, {
      chainId: "11155111",
      nftTokenId: "42",
      liquidityPercentageToDecrease: 35,
    });
    assert.equal(Object.keys(plan.mcpCall.arguments).length, 3);
  });

  it("ignores AI-supplied tool names and rejects tool routing fields on decision", () => {
    assert.throws(
      () =>
        planAction(
          {
            action: "REDUCE_LIQUIDITY",
            liquidityPercentageToDecrease: 10,
            toolName: "claim_v3_fees",
          },
          CTX,
        ),
      /AI-supplied toolName/,
    );
    assert.throws(
      () =>
        planAction(
          {
            action: "REDUCE_LIQUIDITY",
            liquidityPercentageToDecrease: 10,
            mcpCall: { toolName: "create_v3_position" },
          },
          CTX,
        ),
      /AI-supplied toolName\/mcpCall/,
    );
  });

  it("does not use arbitrary AI arguments — only NFT id and percentage from context/decision", () => {
    const plan = planAction(
      {
        action: "REDUCE_LIQUIDITY",
        liquidityPercentageToDecrease: 20,
        // Extra fields that must not become MCP args (also not allowed on validated
        // decisions, but planner must still only emit the three hardcoded keys).
        summary: "x",
        poolAddress: "0xevil",
        slippageTolerance: 99,
      },
      CTX,
    );
    assert.deepEqual(Object.keys(plan.mcpCall.arguments).sort(), [
      "chainId",
      "liquidityPercentageToDecrease",
      "nftTokenId",
    ]);
    assert.equal(plan.mcpCall.arguments.nftTokenId, "42");
    assert.equal(plan.mcpCall.arguments.liquidityPercentageToDecrease, 20);
  });

  it("rejects CLAIM_FEES and unknown actions", () => {
    assert.throws(
      () => planAction({ action: "CLAIM_FEES" }, CTX),
      /unsupported action/,
    );
    assert.throws(
      () => planAction({ action: "CREATE_POSITION" }, CTX),
      /unsupported action/,
    );
  });

  it("uses context NFT id, not any AI-supplied id", () => {
    const plan = planAction(
      {
        action: "REDUCE_LIQUIDITY",
        liquidityPercentageToDecrease: 50,
        summary: "x",
        nftTokenId: "999",
      },
      { nftTokenId: "7", chainId: "11155111" },
    );
    assert.equal(plan.mcpCall.arguments.nftTokenId, "7");
  });
});
