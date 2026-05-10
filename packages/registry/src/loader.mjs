// Node ESM resolver hook. Some published SDKs (notably @1claw/sdk@0.20.4)
// ship compiled ESM with extensionless relative imports — Node 24's strict
// ESM resolver rejects those. We retry such failures with `.js` and
// `/index.js` appended, mirroring legacy CJS resolution semantics.
//
// Registered via `--import ./src/register-loader.mjs` in package scripts.
import { register } from "node:module";

register("./loader-impl.mjs", import.meta.url);
