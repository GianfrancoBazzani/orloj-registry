/**
 * Single-run LP agent entrypoint (no polling loop in Phase 1).
 * Implemented in T7.
 */

import { pathToFileURL } from "node:url";

async function main() {
  console.error(
    JSON.stringify({
      status: "not_implemented",
      phase: 1,
      message:
        "run-once pipeline not implemented yet (T7). Scaffold only — see README.",
    }),
  );
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await main();
}
