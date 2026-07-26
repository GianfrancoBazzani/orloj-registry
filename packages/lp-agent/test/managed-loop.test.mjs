/**
 * Discovery, amounts, and state-store unit tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverManagedPositions } from "../src/discovery.mjs";
import {
  formatHumanAmount,
  budgetsFromDecreaseResponse,
  planRebalanceFunding,
  budgetsAfterSwapQuote,
  halfRawAmount,
  validateCreateSuccessResponse,
} from "../src/amounts.mjs";
import {
  reconcileCreateFromListedPositions,
} from "../src/rebalance.mjs";
import {
  emptyState,
  loadState,
  saveState,
  upsertInProgressRebalance,
  getInProgressRebalance,
  clearInProgressRebalance,
  newCycleId,
} from "../src/state-store.mjs";

describe("discovery", () => {
  it("NFT_TOKEN_ID filter uses env_filter without listing", async () => {
    let listed = 0;
    const result = await discoverManagedPositions(
      {},
      { chainId: "11155111", nftTokenId: "42" },
      {
        listPositions: async () => {
          listed += 1;
          throw new Error("should not list");
        },
      },
    );
    assert.equal(listed, 0);
    assert.equal(result.source, "env_filter");
    assert.deepEqual(result.nftTokenIds, ["42"]);
    assert.equal(result.truncated, false);
  });

  it("requires truncated=false for all-position management", async () => {
    await assert.rejects(
      () =>
        discoverManagedPositions(
          {},
          { chainId: "11155111", nftTokenId: null },
          {
            listPositions: async () => ({
              truncated: true,
              count: 20,
              totalOwned: 25,
              positions: [{ nftTokenId: "1", liquidity: "1" }],
            }),
          },
        ),
      /truncated must be false/,
    );
  });

  it("lists all active positions when truncated=false", async () => {
    const result = await discoverManagedPositions(
      {},
      { chainId: "11155111", nftTokenId: null },
      {
        listPositions: async () => ({
          truncated: false,
          count: 3,
          totalOwned: 3,
          positions: [
            { nftTokenId: "1", liquidity: "10" },
            { nftTokenId: "2", liquidity: "0" },
            { nftTokenId: "3", liquidity: "5" },
          ],
        }),
      },
    );
    assert.equal(result.source, "list_v3_positions");
    assert.deepEqual(result.nftTokenIds, ["1", "3"]);
    assert.equal(result.count, 2);
  });
});

describe("amounts", () => {
  it("formatHumanAmount mirrors registry human decimals", () => {
    assert.equal(formatHumanAmount("1000000000000000000", 18), "1");
    assert.equal(formatHumanAmount("2000000", 6), "2");
    assert.equal(formatHumanAmount("1500000000000000000", 18), "1.5");
  });

  it("budgetsFromDecreaseResponse parses principal amounts", () => {
    const got = budgetsFromDecreaseResponse(
      {
        token0: {
          tokenAddress: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
        },
        token1: {
          tokenAddress: "0x0000000000000000000000000000000000000002",
          amount: "2000000",
        },
      },
      {
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
        decimals0: 18,
        decimals1: 6,
      },
    );
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.maxTokenAAmount, "1");
      assert.equal(got.maxTokenBAmount, "2");
    }
  });

  it("rejects zero principal side for two-sided-only helper", () => {
    const got = budgetsFromDecreaseResponse(
      {
        token0: {
          tokenAddress: "0x0000000000000000000000000000000000000001",
          amount: "0",
        },
        token1: {
          tokenAddress: "0x0000000000000000000000000000000000000002",
          amount: "2000000",
        },
      },
      {
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
        decimals0: 18,
        decimals1: 6,
      },
    );
    assert.equal(got.ok, false);
  });

  it("planRebalanceFunding requests swap for single-sided principal", () => {
    assert.equal(halfRawAmount("100"), "50");
    const planned = planRebalanceFunding(
      {
        token0: {
          tokenAddress: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
        },
        token1: {
          tokenAddress: "0x0000000000000000000000000000000000000002",
          amount: "0",
        },
      },
      {
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
        decimals0: 18,
        decimals1: 6,
      },
    );
    assert.equal(planned.ok, true);
    if (planned.ok && planned.kind === "needs_swap") {
      assert.equal(planned.swap.tokenIn, "0x0000000000000000000000000000000000000001");
      assert.equal(planned.swap.tokenOut, "0x0000000000000000000000000000000000000002");
      const budgets = budgetsAfterSwapQuote({
        surplusSide: planned.swap.surplusSide,
        remainingSurplusRaw: planned.swap.remainingSurplusRaw,
        amountOutRaw: "5000000",
        decimals0: 18,
        decimals1: 6,
        token0: "0x0000000000000000000000000000000000000001",
        token1: "0x0000000000000000000000000000000000000002",
      });
      assert.equal(budgets.ok, true);
    }
  });

  it("validateCreateSuccessResponse requires hash and nftTokenId", () => {
    assert.equal(
      validateCreateSuccessResponse({ hash: "0x1", nftTokenId: "9" }).ok,
      false,
    );
    const ok = validateCreateSuccessResponse({
      hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nftTokenId: "9",
    });
    assert.equal(ok.ok, true);
  });

  it("reconcileCreateFromListedPositions adopts unique same-pool NFT", () => {
    const got = reconcileCreateFromListedPositions(
      {
        positions: [
          { nftTokenId: "7", poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", liquidity: "0" },
          { nftTokenId: "99", poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", liquidity: "1" },
        ],
      },
      {
        oldNftTokenId: "7",
        poolAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
      },
    );
    assert.equal(got.ok, true);
    if (got.ok) assert.equal(got.newNftTokenId, "99");
  });
});

describe("state-store", () => {
  it("persists and recovers in-progress rebalance", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-agent-state-"));
    const path = join(dir, "state.json");
    const state = emptyState();
    upsertInProgressRebalance(state, {
      cycleId: newCycleId(),
      oldNftTokenId: "7",
      poolAddress: "0xpool",
      token0: "0xa",
      token1: "0xb",
      liquidityPercentageToDecrease: 100,
      rangeWidthBps: 1000,
      decrease: {
        status: "succeeded",
        budgets: {
          tokenA: "0xa",
          tokenB: "0xb",
          maxTokenAAmount: "1",
          maxTokenBAmount: "2",
        },
      },
      create: { status: "failed", error: "boom" },
      newNftTokenId: null,
      updatedAt: new Date().toISOString(),
    });
    saveState(path, state);
    const loaded = loadState(path);
    const rec = getInProgressRebalance(loaded, "7");
    assert.ok(rec);
    assert.equal(rec.decrease.status, "succeeded");
    assert.equal(rec.create.status, "failed");
    clearInProgressRebalance(loaded, "7");
    saveState(path, loaded);
    assert.equal(getInProgressRebalance(loadState(path), "7"), null);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.version, 1);
  });

  it("loadState returns empty on missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-agent-state-"));
    const s = loadState(join(dir, "missing.json"));
    assert.deepEqual(s, emptyState());
  });

  it("rejects unsupported version", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-agent-state-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ version: 99, inProgress: {} }));
    assert.throws(() => loadState(path), /unsupported state file version/);
  });
});
