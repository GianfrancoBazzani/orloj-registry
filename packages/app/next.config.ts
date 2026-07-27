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

  // Both are repo-local packages shipping ESM/TypeScript source, so the App Router has to
  // transpile them. Both are linked with `link:../<pkg>` rather than `workspace:^` — this
  // package has its own pnpm-lock.yaml and its pnpm-workspace.yaml declares no `packages:`,
  // so an install run from here cannot resolve the workspace protocol.
  transpilePackages: ["@orloj/lp-agent", "@orloj/skills-marketplace"],

  // The skills marketplace's 0G/ethers deps are CommonJS web3 libraries that must not be
  // bundled. Naming different packages than transpilePackages, so the two do not conflict.
  // They resolve from the monorepo root store via the symlink, which is also why
  // outputFileTracingRoot above has to stay at the repo root.
  serverExternalPackages: ["@0gfoundation/0g-storage-ts-sdk", "ethers"],
};

export default nextConfig;
