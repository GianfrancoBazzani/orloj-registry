-- Raw swap flow. One row per Uniswap V3 Swap event on a tracked pool.
--
-- Deliberately stores RAW swaps, not aggregates: every sentiment metric is then a view
-- over this table, so the window length is a query parameter rather than something
-- baked into the pipeline. It also means the dashboard's "recent swaps" receipts come
-- for free, and any reported figure can be traced back to a specific transaction.
--
-- The registry reads this table via db::sentiment_window / db::recent_swaps
-- (packages/registry/src/db.rs), surfaced by the `feeling` MCP.
CREATE TABLE IF NOT EXISTS swap (
  block_number  BIGINT        NOT NULL,
  block_hash    TEXT          NOT NULL,
  timestamp     TIMESTAMPTZ   NOT NULL,
  tx_hash       TEXT          NOT NULL,
  log_index     INT           NOT NULL,
  pair          TEXT          NOT NULL,
  pool          TEXT          NOT NULL,
  -- Usually a router/settlement contract, NOT the end trader. COUNT(DISTINCT sender)
  -- is therefore a lower bound on real participants.
  sender        TEXT          NOT NULL,
  side          TEXT          NOT NULL CHECK (side IN ('BUY','SELL')),
  -- NUMERIC, never float: this is money. 6 decimals already applied upstream.
  usdc_notional NUMERIC(38,6) NOT NULL,

  -- THE idempotency guarantee. Substreams delivers at-least-once — a disconnect makes
  -- the sink resume from its cursor and replay blocks. Without this composite key those
  -- replays would silently double every volume figure. Must match the create_row key
  -- in db_out (src/lib.rs).
  PRIMARY KEY (tx_hash, log_index)
);

-- Serves the windowed metric query: WHERE pair = $1 AND timestamp > now() - interval.
CREATE INDEX IF NOT EXISTS swap_pair_time_idx ON swap (pair, timestamp DESC);
