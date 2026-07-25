import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pinned because this package carries its own pnpm-workspace.yaml and lockfiles, so Next
  // finds two candidate workspace roots and only guesses at the monorepo root — warning on
  // every build and every boot. The guess is right today; stating it also stops file tracing
  // from silently retargeting to packages/app, which would drop ../zeroclaw-agents from the
  // trace. This is the only knob needed: Next mirrors it into `turbopack.root`, and setting
  // both is an error unless they are identical.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
};

export default nextConfig;
