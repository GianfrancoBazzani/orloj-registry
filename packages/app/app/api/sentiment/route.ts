import {
  fetchExplanation,
  fetchRecentSwaps,
  fetchSentiment,
  isPair,
  SENTIMENT_PAIRS,
  type Pair,
} from "@/lib/sentiment";

// Every call is a live chain read — never serve a cached response.
export const dynamic = "force-dynamic";

const MIN_BLOCKS = 10;
const MAX_BLOCKS = 4000;
const DEFAULT_BLOCKS = 500;

/**
 * GET /api/sentiment?pair=WETH/USDC&blocks=500&detail=full
 *
 * Proxies the bearer-authenticated `feeling` MCP so the browser never sees the token.
 * `detail=full` also returns the prose explanation and the recent-swap receipts,
 * fetched in parallel with the metrics.
 *
 * Expect several seconds: the MCP runs a Substreams module over 2x `blocks` of
 * recent mainnet blocks per call (the older half is the trend window). No cache.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const pairParam = (searchParams.get("pair") ?? "WETH/USDC").toUpperCase();
  if (!isPair(pairParam)) {
    return Response.json(
      {
        error: `unknown pair "${pairParam}"`,
        supported: SENTIMENT_PAIRS,
      },
      { status: 400 },
    );
  }
  const pair: Pair = pairParam;

  const rawBlocks = Number(searchParams.get("blocks") ?? DEFAULT_BLOCKS);
  const blocks = Number.isFinite(rawBlocks)
    ? Math.min(Math.max(Math.trunc(rawBlocks), MIN_BLOCKS), MAX_BLOCKS)
    : DEFAULT_BLOCKS;

  const wantsDetail = searchParams.get("detail") === "full";

  // SEQUENTIAL, not Promise.all. Each MCP tool call opens its own Substreams stream,
  // and the free plan enforces a concurrent-stream cap — firing these in parallel gets
  // one of them killed with:
  //   "ResourceExhausted: Concurrent stream limit"
  // Sequential costs ~2x wall-clock on detail mode but always succeeds. If a paid plan
  // raises the cap, this can go back to Promise.all.
  const sentiment = await fetchSentiment(pair, blocks);

  // Surface upstream failure as 502 — it is a gateway problem, not a client error.
  if ("error" in sentiment) {
    return Response.json({ pair, ...sentiment }, { status: 502 });
  }

  const explanation = wantsDetail ? await fetchExplanation(pair, blocks) : null;
  const recent = wantsDetail ? await fetchRecentSwaps(pair, blocks, 8) : null;

  return Response.json({
    ...sentiment,
    explanation:
      explanation && !("error" in explanation) ? explanation.explanation : null,
    recentSwaps: recent && !("error" in recent) ? recent.swaps : null,
  });
}
