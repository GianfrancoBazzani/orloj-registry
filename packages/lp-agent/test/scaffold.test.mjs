import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SUBGRAPH_ID,
  DEFAULT_CHAIN_ID,
  PHASE1_ACTIONS,
  toSubgraphPoolId,
} from "../src/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("lp-agent scaffold", () => {
  it("exposes Sepolia defaults and Phase 1 actions", () => {
    assert.equal(
      DEFAULT_SUBGRAPH_ID,
      "2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR",
    );
    assert.equal(DEFAULT_CHAIN_ID, "11155111");
    assert.deepEqual([...PHASE1_ACTIONS], ["HOLD", "REDUCE_LIQUIDITY"]);
    assert.ok(!PHASE1_ACTIONS.includes("CLAIM_FEES"));
    assert.equal(toSubgraphPoolId("0xAbC"), "0xabc");
  });

  it("declares zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.ok(pkg.engines?.node?.includes("24"));
  });

  it("documents Graph bearer auth and Phase 1 scope in README", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.match(readme, /2vXTcbEvA3TGTufatwRVUXQjJZDKCHmzZmZKYYXxaeeR/);
    assert.match(readme, /Authorization: Bearer/);
    assert.match(readme, /Phase 1/);
    assert.match(readme, /Phase 2/);
    assert.match(readme, /HOLD/);
    assert.match(readme, /REDUCE_LIQUIDITY/);
    assert.match(readme, /periodStartUnix/);
    assert.match(readme, /Live schema probe/);
    assert.match(readme, /pairContextFromMarket/);
    assert.match(readme, /decrease_v3_position/);
    assert.match(readme, /execution\.status=held/);
    assert.match(readme, /Phase 1 audit stop/);
  });
});
