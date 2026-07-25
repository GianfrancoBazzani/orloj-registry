import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SUBGRAPH_ID } from "../src/config.mjs";
import {
  asGraphString,
  parseGraphHttpJson,
  normalizePoolMarketContext,
  fetchPoolMarketContext,
  POOL_MARKET_CONTEXT_QUERY,
} from "../src/graph-client.mjs";

const NOW = 1_700_000_000;
const POOL = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const POOL_ID = POOL.toLowerCase();
const HOUR_START = NOW - 48 * 3600;
const SWAP_START = NOW - 24 * 3600;

const TOKEN0 = {
  id: "0x0000000000000000000000000000000000000001",
  symbol: "AAA",
  decimals: "18",
  name: "Token A",
};
const TOKEN1 = {
  id: "0x0000000000000000000000000000000000000002",
  symbol: "BBB",
  decimals: "6",
  name: "Token B",
};

function freshMeta(overrides = {}) {
  return {
    block: {
      number: "11348887",
      hash: "0xabc",
      timestamp: String(NOW - 60),
      ...overrides.block,
    },
    hasIndexingErrors: false,
    deployment: "QmTest",
    ...overrides,
    block: {
      number: "11348887",
      hash: "0xabc",
      timestamp: String(NOW - 60),
      ...(overrides.block ?? {}),
    },
  };
}

function validPool(overrides = {}) {
  return {
    id: POOL_ID,
    tick: "100",
    sqrtPrice: "79228162514264337593543950336",
    liquidity: "1000000000000000000",
    feeTier: "3000",
    totalValueLockedUSD: "123.45",
    totalValueLockedToken0: "1.0",
    totalValueLockedToken1: "2.0",
    volumeUSD: "10",
    volumeToken0: "3",
    volumeToken1: "4",
    feesUSD: "0.1",
    token0: TOKEN0,
    token1: TOKEN1,
    ...overrides,
  };
}

function validData(overrides = {}) {
  return {
    _meta: freshMeta(overrides._meta),
    pool: overrides.pool === undefined ? validPool(overrides.poolFields) : overrides.pool,
    poolHourDatas:
      overrides.poolHourDatas === undefined
        ? [
            {
              id: `${POOL_ID}-1`,
              periodStartUnix: NOW - 7200,
              tick: "99",
              liquidity: "1000",
              sqrtPrice: "1",
              tvlUSD: "10",
              volumeUSD: "1",
              volumeToken0: "0.1",
              volumeToken1: "0.2",
              feesUSD: "0.01",
              open: "1",
              high: "2",
              low: "0.5",
              close: "1.5",
              token0Price: "1",
              token1Price: "1",
              txCount: "3",
            },
          ]
        : overrides.poolHourDatas,
    swaps:
      overrides.swaps === undefined
        ? [
            {
              id: "0xswap-1",
              timestamp: String(NOW - 100),
              tick: "100",
              amount0: "0.1",
              amount1: "-0.2",
              amountUSD: "5",
              sqrtPriceX96: "1",
            },
          ]
        : overrides.swaps,
  };
}

function normalizeOpts(extra = {}) {
  return {
    poolId: POOL_ID,
    subgraphId: DEFAULT_SUBGRAPH_ID,
    nowSeconds: NOW,
    maxIndexedAgeSeconds: 3600,
    hourStartUnix: HOUR_START,
    swapStartUnix: SWAP_START,
    ...extra,
  };
}

describe("graph-response", () => {
  it("preserves large Graph numerics as strings", () => {
    assert.equal(asGraphString("79228162514264337593543950336", "x"), "79228162514264337593543950336");
    assert.equal(asGraphString(100, "x"), "100");
    assert.throws(() => asGraphString(null, "x"), /string or number/);
  });

  it("happy path: normalizes pool, timestamp-bounded hours/swaps, and _meta", () => {
    const ctx = normalizePoolMarketContext(validData(), normalizeOpts());
    assert.equal(ctx.poolId, POOL_ID);
    assert.equal(ctx.pool.tick, "100");
    assert.equal(ctx.pool.sqrtPrice, "79228162514264337593543950336");
    assert.equal(typeof ctx.pool.liquidity, "string");
    assert.equal(ctx.meta.hasIndexingErrors, false);
    assert.equal(ctx.meta.blockNumber, "11348887");
    assert.equal(ctx.hourData.length, 1);
    assert.equal(ctx.hourData[0].periodStartUnix, String(NOW - 7200));
    assert.equal(ctx.swaps.length, 1);
    assert.equal(ctx.windows.hour.boundBy, "periodStartUnix");
    assert.equal(ctx.windows.swap.boundBy, "timestamp");
    assert.equal(ctx.inactivity.noHourRows, false);
    assert.equal(ctx.inactivity.noSwapRows, false);
  });

  it("happy path inactivity: fresh _meta with empty hours and swaps is OK", () => {
    const ctx = normalizePoolMarketContext(
      validData({ poolHourDatas: [], swaps: [] }),
      normalizeOpts(),
    );
    assert.equal(ctx.pool.id, POOL_ID);
    assert.equal(ctx.hourData.length, 0);
    assert.equal(ctx.swaps.length, 0);
    assert.equal(ctx.inactivity.noHourRows, true);
    assert.equal(ctx.inactivity.noSwapRows, true);
  });

  it("fail closed: GraphQL errors", () => {
    assert.throws(
      () =>
        parseGraphHttpJson({
          errors: [{ message: "indexing broken" }],
          data: null,
        }),
      /GraphQL errors: indexing broken/,
    );
  });

  it("fail closed: invalid / non-object JSON body shape", () => {
    assert.throws(() => parseGraphHttpJson(null), /JSON object/);
    assert.throws(() => parseGraphHttpJson([]), /JSON object/);
    assert.throws(() => parseGraphHttpJson({ data: null }), /missing data/);
  });

  it("fail closed: indexing errors", () => {
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({ _meta: { hasIndexingErrors: true, block: { number: "1", hash: "0x1", timestamp: String(NOW) } } }),
          normalizeOpts(),
        ),
      /indexing errors/,
    );
  });

  it("fail closed: stale _meta", () => {
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({
            _meta: {
              hasIndexingErrors: false,
              block: {
                number: "1",
                hash: "0x1",
                timestamp: String(NOW - 10_000),
              },
            },
          }),
          normalizeOpts({ maxIndexedAgeSeconds: 3600 }),
        ),
      /stale/,
    );
  });

  it("fail closed: missing pool", () => {
    assert.throws(
      () =>
        normalizePoolMarketContext(validData({ pool: null }), normalizeOpts()),
      /pool not found/,
    );
  });

  it("fail closed: malformed essential pool fields", () => {
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({ poolFields: { tick: null } }),
          normalizeOpts(),
        ),
      /pool\.tick/,
    );
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({ poolFields: { id: "0xabc" } }),
          normalizeOpts(),
        ),
      /address/,
    );
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({ poolFields: { token0: null } }),
          normalizeOpts(),
        ),
      /token0/,
    );
  });

  it("fail closed: hour row outside periodStartUnix window", () => {
    assert.throws(
      () =>
        normalizePoolMarketContext(
          validData({
            poolHourDatas: [
              {
                id: "old",
                periodStartUnix: HOUR_START - 1,
                tick: "1",
                liquidity: "1",
                sqrtPrice: "1",
              },
            ],
          }),
          normalizeOpts(),
        ),
      /outside requested window/,
    );
  });

  it("query document bounds hours by periodStartUnix, not array position", () => {
    assert.match(POOL_MARKET_CONTEXT_QUERY, /periodStartUnix_gte/);
    assert.match(POOL_MARKET_CONTEXT_QUERY, /orderBy: periodStartUnix/);
    assert.doesNotMatch(POOL_MARKET_CONTEXT_QUERY, /first:\s*6\b/);
  });

  it("fetchPoolMarketContext posts Bearer auth and normalizes lowercase pool id", async () => {
    /** @type {unknown} */
    let seenBody;
    const fetchImpl = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: validData() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await fetchPoolMarketContext(
      {
        graphUrl: "https://gateway.thegraph.com/api/subgraphs/id/test",
        apiKey: "graph-secret-key",
        subgraphId: DEFAULT_SUBGRAPH_ID,
        fetchImpl,
        nowSeconds: () => NOW,
        maxIndexedAgeSeconds: 3600,
        timeoutMs: 5_000,
      },
      { poolAddress: POOL },
    );

    assert.equal(
      /** @type {{ variables: { poolId: string } }} */ (seenBody).variables.poolId,
      POOL_ID,
    );
    assert.equal(
      /** @type {{ variables: { hourStartUnix: number } }} */ (seenBody).variables
        .hourStartUnix,
      HOUR_START,
    );
    assert.equal(result.poolId, POOL_ID);
    assert.equal(result.pool.liquidity, "1000000000000000000");
  });

  it("fail closed: HTTP errors (API key redacted if echoed)", async () => {
    const apiKey = "graph_live_secret_abc";
    const fetchImpl = async () =>
      new Response(`denied key=${apiKey}`, { status: 403 });

    let message = "";
    try {
      await fetchPoolMarketContext(
        {
          graphUrl: "https://gateway.test/subgraph",
          apiKey,
          fetchImpl,
          nowSeconds: () => NOW,
          timeoutMs: 5_000,
        },
        { poolAddress: POOL },
      );
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.match(message, /Graph HTTP 403/);
    assert.doesNotMatch(message, new RegExp(apiKey));
  });

  it("fail closed: invalid JSON body", async () => {
    const fetchImpl = async () => new Response("not-json{", { status: 200 });
    await assert.rejects(
      () =>
        fetchPoolMarketContext(
          {
            graphUrl: "https://gateway.test/subgraph",
            apiKey: "k",
            fetchImpl,
            nowSeconds: () => NOW,
          },
          { poolAddress: POOL },
        ),
      /invalid JSON/,
    );
  });

  it("fail closed: timeout", async () => {
    const fetchImpl = async (_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    await assert.rejects(
      () =>
        fetchPoolMarketContext(
          {
            graphUrl: "https://gateway.test/subgraph",
            apiKey: "k",
            fetchImpl,
            nowSeconds: () => NOW,
            timeoutMs: 20,
          },
          { poolAddress: POOL },
        ),
      /timed out/,
    );
  });
});
