# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`orloj-registry` — MCP contracts/interfaces for AI agents. ETHPrague Hackathon 2026 project. Currently a scaffold with most domain code unwritten.

## Repo layout

pnpm workspace monorepo (see [pnpm-workspace.yaml](pnpm-workspace.yaml)):

- [packages/app/](packages/app/) — Next.js 16.2.6 + React 19.2.4 + Tailwind v4 frontend. Currently the default `create-next-app` scaffold; the real UI hasn't been built yet.
- [packages/registry/](packages/registry/) — empty placeholder. The "registry" of MCP contracts is expected to live here.

The root `package.json` declares no scripts; commands are run inside individual packages.

## Toolchain (non-obvious)

- **Node 24.15.0** is pinned via [.npmrc](.npmrc) (`use-node-version=24.15.0`) with `engine-strict=true`. pnpm will refuse to install on the wrong Node.
- **pnpm 10.33.2** is pinned via `packageManager` in root [package.json](package.json) and `manage-package-manager-versions=true` in `.npmrc`. Use `pnpm`, not `npm`/`yarn`.
- `prefer-frozen-lockfile=true` — install with `pnpm install --frozen-lockfile` in CI-like contexts; locally `pnpm install` is fine when adding deps.
- `link-workspace-packages=false` — workspace packages are NOT auto-linked. To depend on another workspace package, declare it explicitly with the `workspace:` protocol (saved as `workspace:^` per `save-workspace-protocol=rolling`).

## Common commands

Run from `packages/app/`:

```bash
pnpm dev      # next dev — local development server on :3000
pnpm build    # next build
pnpm start    # next start (after build)
pnpm lint     # eslint (eslint-config-next core-web-vitals + typescript)
```

There is no test runner configured yet, and no root-level orchestration scripts.

## Critical: Next.js 16 is not the Next.js you know

[packages/app/AGENTS.md](packages/app/AGENTS.md) (also imported by [packages/app/CLAUDE.md](packages/app/CLAUDE.md)) warns:

> This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Before editing anything in `packages/app/`, consult `packages/app/node_modules/next/dist/docs/` for the correct current API. Do not rely on memorized Next.js patterns. Tailwind is v4 (PostCSS plugin only — `@tailwindcss/postcss`), not v3.

## TypeScript path alias

Inside `packages/app/`, `@/*` maps to the package root (see [packages/app/tsconfig.json](packages/app/tsconfig.json)) — e.g. `@/app/page` → `./app/page`.

## Adding dependencies

Before installing any new dependency:

1. **Ask the user to confirm** the addition — do not silently add deps to `package.json`.
2. **Look up the latest published version** (e.g. `pnpm view <pkg> version`) rather than using a version from training data, which is likely stale.
3. **Install it pinned to that exact latest version**. `.npmrc` already sets `save-exact=true`, so `pnpm add <pkg>` will write the exact resolved version — but always verify the version that landed in `package.json` matches the latest you looked up. Do not write `^` / `~` ranges by hand.
