// Server-side client for the `feeling` MCP (onchain flow sentiment).
//
// SERVER ONLY. The MCP is bearer-authenticated, and that token must never reach the
// browser — hence this helper plus the thin /api/sentiment route, mirroring how
// lib/registry-mcps.ts + app/api/mcps/route.ts already split registry access.
//
// The MCP speaks JSON-RPC, not REST, and computes on demand: each call runs a
// Substreams module over 2x `blocks` of recent mainnet blocks (the older half is the
// trend window), so expect several seconds. Nothing is cached; the freshness is the point.

const PAIRS = ["WETH/USDC"] as const;
export type Pair = (typeof PAIRS)[number];

export const SENTIMENT_PAIRS: readonly Pair[] = PAIRS;

export const isPair = (v: string): v is Pair => PAIRS.includes(v as Pair);

/** Labels the MCP can return. Mirrors mcps::feeling::metrics::Sentiment. */
export type SentimentLabel =
  | "BUY_PRESSURE"
  | "MILD_BUY_PRESSURE"
  | "BALANCED"
  | "MILD_SELL_PRESSURE"
  | "SELL_PRESSURE"
  | "INSUFFICIENT_DATA";

export interface Sentiment {
  pair: string;
  blocksAnalysed: number;
  fromBlock: number;
  toBlock: number;
  approxWindowMinutes: number;
  sentiment: SentimentLabel;
  netFlowUsdc: number;
  buyVolumeUsdc: number;
  sellVolumeUsdc: number;
  /** null when the window is empty — NOT 0. "No data" must never read as "balanced". */
  imbalance: number | null;
  imbalanceByCount: number | null;
  /** null when there is no comparable previous window. */
  trend: number | null;
  previousImbalance: number | null;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueSenders: number;
  participationFloor: number;
  whaleDivergence: boolean;
  latestBlock: number | null;
  secondsSinceLatestSwap: number | null;
  fetchMs: number;
  caveats: string;
}

export interface SentimentError {
  error: string;
}

export type SentimentResult = Sentiment | SentimentError;

export const isError = (r: SentimentResult): r is SentimentError =>
  (r as SentimentError).error !== undefined;

/** One JSON-RPC tools/call against the feeling MCP. */
async function callTool(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl) throw new Error("REGISTRY_URL is not set");

  const token = process.env.SENTIMENT_MCP_TOKEN;
  if (!token) throw new Error("SENTIMENT_MCP_TOKEN is not set");

  // The MCP call is a live chain fetch; without an abort it can hang a page render.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${registryUrl}/interface/feeling/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "registry rejected the token (401) — check SENTIMENT_MCP_TOKEN"
          : `registry returned ${res.status}`,
      );
    }

    const body = await res.json();

    if (body.error) {
      throw new Error(body.error.message ?? "JSON-RPC error");
    }

    const result = body.result;
    const text: string | undefined = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("unexpected MCP response shape");
    }

    // A tool-level failure (bad args, substreams unreachable) comes back as isError
    // with the message in the text field, not as a transport error.
    if (result.isError) throw new Error(text);

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch current sentiment for one pair.
 *
 * Returns a `{ error }` object rather than throwing, so a failing pair degrades to an
 * error card instead of taking down the whole page — same posture as fetchMcps().
 */
export async function fetchSentiment(
  pair: Pair,
  blocks = 500,
): Promise<SentimentResult> {
  try {
    const data = (await callTool(
      "get_sentiment",
      { pair, blocks },
      200_000,
    )) as Sentiment;
    return data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "The operation was aborted.") {
      return { error: "timed out fetching blocks from mainnet" };
    }
    // The free Substreams plan caps concurrent streams; the raw message is a wall of
    // gRPC text, so name the actual cause.
    if (msg.includes("ResourceExhausted") || msg.includes("Concurrent stream")) {
      return {
        error:
          "upstream concurrent-stream limit reached — another sentiment request is " +
          "still running. It will retry on the next refresh.",
      };
    }
    return { error: msg };
  }
}

/** Plain-language explanation of the current reading, generated from the numbers. */
export async function fetchExplanation(
  pair: Pair,
  blocks = 500,
): Promise<{ explanation: string } | SentimentError> {
  try {
    const data = (await callTool(
      "explain_sentiment",
      { pair, blocks },
      200_000,
    )) as { explanation: string };
    return data;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RecentSwap {
  txHash: string;
  logIndex: number;
  side: "BUY" | "SELL";
  usdcNotional: number;
  sender: string;
  blockNumber: number;
}

/** The individual swaps behind the aggregate — the receipts. */
export async function fetchRecentSwaps(
  pair: Pair,
  blocks = 500,
  limit = 8,
): Promise<{ swaps: RecentSwap[] } | SentimentError> {
  try {
    const data = (await callTool(
      "get_recent_swaps",
      { pair, blocks, limit },
      200_000,
    )) as { swaps: RecentSwap[] };
    return data;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
