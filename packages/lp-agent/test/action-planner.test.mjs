/**
 * Decision → proposed MCP action mapping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DECREASE_V3_POSITION_TOOL,
  CREATE_V3_POSITION_TOOL,
  planAction,
} from "../src/action-planner.mjs";

const CTX = { nftTokenId: "42", chainId: "11155111" };
const REBALANCE_CTX = {
  nftTokenId: "42",
  chainId: "11155111",
  token0: "0x0000000000000000000000000000000000000001",
  token1: "0x0000000000000000000000000000000000000002",
  poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
};

describe("action-planner", () => {
  it("HOLD produces no write plan", () => {
    const plan = planAction(
      {
        action: "HOLD",
        confidence: 0.5,
        liquidityPercentageToDecrease: null,
        rangeWidthBps: null,
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
        rangeWidthBps: null,
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

  it("REBALANCE proposes decrease+create with position-pinned pair/pool", () => {
    const plan = planAction(
      {
        action: "REBALANCE",
        confidence: 0.9,
        liquidityPercentageToDecrease: 100,
        rangeWidthBps: 500,
        summary: "rebalance",
        signals: [],
        uncertainties: [],
        graphEvidence: {},
      },
      REBALANCE_CTX,
    );
    assert.equal(plan.kind, "rebalance");
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].toolName, DECREASE_V3_POSITION_TOOL);
    assert.equal(plan.steps[1].toolName, "swap");
    assert.equal(plan.steps[1].optional, true);
    assert.equal(plan.steps[2].toolName, CREATE_V3_POSITION_TOOL);
    assert.deepEqual(plan.steps[0].arguments, {
      chainId: "11155111",
      nftTokenId: "42",
      liquidityPercentageToDecrease: 100,
    });
    assert.equal(plan.steps[2].arguments.tokenA, REBALANCE_CTX.token0);
    assert.equal(plan.steps[2].arguments.tokenB, REBALANCE_CTX.token1);
    assert.equal(plan.steps[2].arguments.poolAddress, REBALANCE_CTX.poolAddress);
    assert.equal(plan.steps[2].arguments.rangeWidthBps, 500);
    assert.equal(plan.steps[2].arguments.maxTokenAAmount, null);
    assert.equal(plan.steps[2].arguments.maxTokenBAmount, null);
  });

  it("REBALANCE rejects AI-supplied tool names/addresses/pool", () => {
    assert.throws(
      () =>
        planAction(
          {
            action: "REBALANCE",
            liquidityPercentageToDecrease: 100,
            rangeWidthBps: 1000,
            toolName: "claim_v3_fees",
          },
          REBALANCE_CTX,
        ),
      /AI-supplied toolName/,
    );
    assert.throws(
      () =>
        planAction(
          {
            action: "REBALANCE",
            liquidityPercentageToDecrease: 100,
            rangeWidthBps: 1000,
            poolAddress: "0x0000000000000000000000000000000000000bad",
          },
          REBALANCE_CTX,
        ),
      /AI-supplied poolAddress/,
    );
    assert.throws(
      () =>
        planAction(
          {
            action: "REBALANCE",
            liquidityPercentageToDecrease: 100,
            rangeWidthBps: 1000,
            tokenA: "0xevil",
          },
          REBALANCE_CTX,
        ),
      /AI-supplied tokenA/,
    );
  });

  it("ignores AI-supplied tool names and rejects tool routing fields on decision", () => {
    assert.throws(
      () =>
        planAction(
          {
            action: "REDUCE_LIQUIDITY",
            liquidityPercentageToDecrease: 10,
            rangeWidthBps: null,
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
            rangeWidthBps: null,
            mcpCall: { toolName: "create_v3_position" },
          },
          CTX,
        ),
      /AI-supplied mcpCall/,
    );
  });

  it("does not use arbitrary AI arguments — only NFT id and percentage from context/decision", () => {
    const plan = planAction(
      {
        action: "REDUCE_LIQUIDITY",
        liquidityPercentageToDecrease: 20,
        rangeWidthBps: null,
        summary: "x",
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

  it("rejects non-Sepolia chainId including mainnet 1", () => {
    assert.throws(
      () =>
        planAction(
          {
            action: "REDUCE_LIQUIDITY",
            liquidityPercentageToDecrease: 10,
            rangeWidthBps: null,
            summary: "x",
          },
          { nftTokenId: "42", chainId: "1" },
        ),
      /11155111/,
    );
    assert.throws(
      () =>
        planAction(
          {
            action: "HOLD",
            liquidityPercentageToDecrease: null,
            rangeWidthBps: null,
            summary: "x",
          },
          { nftTokenId: "42", chainId: "1" },
        ),
      /11155111/,
    );
  });

  it("pins REDUCE mcpCall.arguments.chainId to Sepolia", () => {
    const plan = planAction(
      {
        action: "REDUCE_LIQUIDITY",
        liquidityPercentageToDecrease: 15,
        rangeWidthBps: null,
        summary: "x",
      },
      { nftTokenId: "42", chainId: "11155111" },
    );
    assert.equal(plan.mcpCall.arguments.chainId, "11155111");
  });
});
