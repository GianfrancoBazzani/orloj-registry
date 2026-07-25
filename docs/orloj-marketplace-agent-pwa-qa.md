# 1. What was changed

- Rebuilt the MCP listing around compact marketplace cards with real platform, token, interaction, description, and tool-count metadata.
- Added platform, token, and interaction filters plus broader text search.
- Added persistent agent-to-MCP assignments, owner-scoped APIs, profile/launch-modal integration, legacy-binding migration, and registry-side authorization.
- Added a private per-agent PWA shell, unique credentialed manifest, generated Orloj/MCP icons, safe name/PNG overrides, install control, and a protected chatbot integration mount.
- Added localized ETH Lisbon participant and ETHPrague hackathon-winner badges.

# 2. What files changed

- Planning/QA: `docs/orloj-marketplace-agent-pwa-plan.md`, `docs/orloj-marketplace-agent-pwa-plan-review.md`, `docs/orloj-marketplace-agent-pwa-qa.md`.
- Marketplace/app data: `packages/app/components/explore.tsx`, `packages/app/components/data.ts`, `packages/app/lib/registry-mcps.ts`, `packages/app/app/globals.css`.
- Assignment behavior: `packages/app/lib/agent-mcps.ts`, `packages/app/lib/db.ts`, `packages/app/app/api/agents/route.ts`, `packages/app/app/api/agents/[id]/mcps/route.ts`, `packages/app/app/api/agents/[id]/context/route.ts`, `packages/app/app/api/metrics/route.ts`, `packages/app/components/launch-modal.tsx`, `packages/app/components/profile.tsx`.
- Per-agent PWA: `packages/app/lib/agent-branding.ts`, `packages/app/app/[lang]/agents/[id]/page.tsx`, `packages/app/app/api/agents/[id]/branding/route.ts`, `packages/app/app/api/agents/[id]/manifest.webmanifest/route.ts`, `packages/app/app/api/agents/[id]/icon/[size]/route.ts`, `packages/app/components/agent-app.tsx`, `packages/app/components/shell.tsx`.
- Landing/localization: `packages/app/components/landing.tsx` and all six files in `packages/app/dictionaries/`.
- Registry: `packages/registry/src/db.rs`, `packages/registry/src/server.rs`.

# 3. What requested requirements are fully complete

- Compact, higher-contrast marketplace cards with no oversized decorative banner or fake rating/popularity UI.
- Search and filters for blockchain platform/network, token, and read-only/transactional/mixed interaction.
- Deterministic registry metadata with safe app-side fallbacks for staggered deployment.
- Explicit, persisted MCP assignment to an owned agent and assignment enforcement for normal and Uniswap registry routes.
- Existing user-level bindings are migrated to each owned agent to prevent rollout access regressions.
- Stable server-side chatbot handoff: the public context contains assigned MCP metadata but no bearer token; the server-only runtime helper resolves credentials.
- A distinct private PWA identity per agent, 192/512 generated icons, editable app name/PNG icon, install-button behavior, and manual fallback copy.
- ETH Lisbon is labeled only as current participation; ETHPrague is labeled as hackathon winner in all supported locales.

# 4. What requested requirements are partial and why

- The chatbot itself is intentionally not implemented. Per product-owner direction, Gianfranco is building it; this change supplies the protected mount, assigned-MCP context endpoint, and server-only credential contract it needs.
- Browser install UI was implemented and production-built, but a full installed-app test requires a deployed HTTPS origin plus a real authenticated agent. The local review could not safely create or use production agent credentials.
- Live production currently returns the old registry metadata shape. The app fallbacks work, but token/tool/interaction values become complete only after the Rust registry portion is deployed.

# 5. Regression risks

- Deploy the assignment-capable Next app first so it creates/backfills `agent_mcp_binding`; deploy Rust enforcement second. Reversing this order can temporarily reject MCP calls.
- ABI-derived token detection is intentionally conservative. Generic contracts show no token rather than an invented token label.
- Authenticated manifests and icons depend on browsers sending same-origin credentials. Unsupported install-prompt browsers use the documented browser-menu fallback.
- Changing an agent's assignments or branding changes icon/manifest content. Private `no-store` headers prevent shared-cache leakage, but an already installed OS icon may refresh on the browser's schedule.

# 6. Security checks performed

- Confirmed assignment, branding, context, manifest, icon, and app routes require a session and assert `agent_ownership`.
- Confirmed Rust authorizes the authenticated `agent_id` against the requested `mcp_name` and returns `403` for unassigned MCPs.
- Confirmed the public context omits API keys; credential resolution remains in a `server-only` module.
- Confirmed all SQL values use parameters and assignment metrics join through ownership.
- Confirmed registry/user metadata is rendered as React/JSON text with control-character bounds and no raw HTML.
- Confirmed icon overrides accept only local PNG bytes, at most 1 MiB, square 192–1024px, with valid signature/IHDR and no APNG; SVGs, URLs, paths, and remote fetches are not accepted.
- Confirmed custom names reject control and bidirectional override characters, and manifest/icon identity retains Orloj branding.
- Confirmed manifest/icon/context/branding responses use private `no-store`; icon/manifest responses add `nosniff` and restrictive CSP headers.
- Confirmed manifest IDs and start URLs are agent-specific.

# 7. Manual test checklist

- [x] Parse all six dictionaries as JSON.
- [x] Run app lint: zero errors; nine pre-existing warnings remain.
- [x] Run a full Next.js production build with a validation auth secret.
- [x] Run `cargo check`.
- [x] Run Rust unit/doc tests: two metadata tests passed.
- [x] Inspect `/es/explore` at 1440×1000 with live registry data.
- [x] Inspect `/es/explore` at 390×844; confirm one-column compact cards, visible search/filters, and no horizontal overflow.
- [ ] In staging, sign in as user A, assign one EVM MCP and Uniswap to agent A, and verify both appear in the agent app.
- [ ] Verify agent A's key gets `403` for an MCP assigned only to agent B.
- [ ] Verify user B receives `404`/not-found behavior for user A's agent app, manifest, icon, and branding routes.
- [ ] Upload a valid square PNG, save a custom name, and verify both 192/512 icons plus the manifest retain Orloj identity.
- [ ] Attempt SVG, APNG, nonsquare, undersized, oversized, and over-1-MiB uploads; verify `400` responses.
- [ ] Install an agent PWA from staging HTTPS in a supported Chromium browser; verify its identity/start URL and browser-menu fallback on Safari/iOS.
- [ ] Deploy the Next app before Rust registry enforcement, then verify existing legacy bindings were backfilled.
