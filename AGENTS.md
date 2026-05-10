# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`orloj-registry` — MCP contracts/interfaces for AI agents. ETHPrague Hackathon 2026 project. Two implemented workspaces: a registry server that turns Sourcify-verified ABIs into MCP servers and signs via pluggable KMS, plus a Next.js control-plane that owns auth, vaults, agents, and MCP API keys.

## Repo layout

pnpm workspace monorepo (see [pnpm-workspace.yaml](pnpm-workspace.yaml)):

- [packages/registry/](packages/registry/) — Express 5 + `@modelcontextprotocol/sdk` server (`src/server.mjs`). Endpoints: `GET /healthz`, `GET /mcp` (manifest list), `POST /register` (Sourcify lookup → persists to `contracts.json` → builds MCP), `POST /interface/:name/mcp` (bearer-auth, per-agent MCP over Streamable HTTP). `src/generate-mcp.js` converts ABIs to Zod-typed tools (view → `readContract`, write → `signTransaction` → `sendRawTransaction`, plus native-token MCPs). `src/sign-transaction.js` + `src/vault-resolve.js` + `src/vault-providers/{oneclaw,orbitport}.js` route signing per agent. `src/auth.mjs` validates `mcp_api_key` rows in Postgres with `timingSafeEqual`. `src/loader{,-impl}.mjs` is an ESM resolver hook that re-adds `.js` to extensionless imports — required because `@1claw/sdk@0.20.4` ships them and Node 24's strict ESM resolver rejects them. Runs on `:3001` by default.
- [packages/app/](packages/app/) — Next.js 16 control plane. Pages: `/`, `/explore`, `/register`, `/profile`, `/docs`. API routes under `app/api/`: `agents`, `agents/[id]`, `agents/[id]/rotate-key`, `vaults`, `vaults/[id]`, `vaults/[id]/secrets`, `vaults/[id]/key-grants`, `vaults/[id]/sign-test`, `register` (proxies registry), `mcps`, `auth/[...all]`. `lib/auth.ts` is Better-Auth with magic-link (Resend) + SIWE + post-SIWE ENS refresh. `lib/db.ts` provisions schema on first pool acquire (`vault_ownership`, `agent_ownership`, `mcp_api_key`, `orbitport_vault`, `orbitport_secret`, `orbitport_grant`). `lib/vault-providers/{oneclaw,orbitport}.ts` are the TS provider abstraction; the Orbitport provider provisions one secp256k1 + one AES-256-GCM key per vault and stores ciphertext rows in our Postgres (envelope encryption). `lib/mcp-tokens.ts` issues `mcpk_live_*` bearer tokens that the registry verifies.

The root `package.json` declares no scripts; commands are run inside individual packages.

## Toolchain (non-obvious)

- **Node 24.15.0** is pinned via [.npmrc](.npmrc) (`use-node-version=24.15.0`) with `engine-strict=true`. pnpm will refuse to install on the wrong Node.
- **pnpm 10.33.2** is pinned via `packageManager` in root [package.json](package.json) and `manage-package-manager-versions=true` in `.npmrc`. Use `pnpm`, not `npm`/`yarn`.
- `prefer-frozen-lockfile=true` — install with `pnpm install --frozen-lockfile` in CI-like contexts; locally `pnpm install` is fine when adding deps.
- `link-workspace-packages=false` — workspace packages are NOT auto-linked. To depend on another workspace package, declare it explicitly with the `workspace:` protocol (saved as `workspace:^` per `save-workspace-protocol=rolling`).

## Common commands

From `packages/app/`:

```bash
pnpm dev      # next dev — local development server on :3000
pnpm build    # next build
pnpm start    # next start (after build)
pnpm lint     # eslint (eslint-config-next core-web-vitals + typescript)
```

From `packages/registry/`:

```bash
pnpm dev      # node --import ./src/loader.mjs --watch --watch-path=src src/server.mjs (port :3001)
pnpm start    # same, no --watch
```

Both registry scripts use `node --env-file-if-exists=.env.local` and require the `--import ./src/loader.mjs` ESM resolver hook — don't drop it. Hot-reload is Node's built-in `--watch`, not chokidar.

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
