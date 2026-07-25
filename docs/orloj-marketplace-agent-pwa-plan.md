# 1. Scope

Update the existing Orloj application without adding ratings, reviews, recommendations, monetization, publisher, social, or analytics features. The delivery covers:

- A compact marketplace-style MCP registry with search and filters for blockchain platform, token, and interaction type.
- Persisted, owner-scoped agent-to-MCP assignments and a stable integration contract for Gianfranco's chatbot work; this branch does not implement chat or an LLM runtime.
- One installable PWA identity per agent, generated default name/description/icon, safe pre-install name/icon overrides, and a supported-browser install button.
- Landing badges for current ETH Lisbon hackathon participation and the existing ETHPrague win.
- The required plan, plan review, and QA artifacts.

# 2. Current implementation findings

- `packages/app/components/explore.tsx` renders 80px decorative banners, fixed-height summaries, mock call/star data, and a dominant primary CTA. The production mobile card is much taller than its useful content.
- `packages/app/lib/registry-mcps.ts` expects metadata that `packages/registry/src/server.rs` does not return (`toolCount`, token/native flags, descriptions), so live cards have empty summaries and incomplete metrics.
- `Mcp` currently models chain/tags/stars but not explicit token or interaction metadata. Search/filter is limited to chain and tag.
- `packages/app/components/launch-modal.tsx` selects an agent and exposes its config, but never persists an agent-to-MCP assignment. `user_mcp_binding` is user-scoped and unused by that flow.
- Registry bearer authentication resolves an agent but does not authorize that agent for the requested MCP, allowing privilege confusion.
- Agents are owned correctly through `agent_ownership`; there is no PWA manifest, agent app route, branding storage, install flow, or icon pipeline.
- Landing copy is localized in six dictionaries. The repo describes an ETHPrague 2026 hackathon project; product direction confirms ETH Lisbon is current participation, not a win.

# 3. MCP registry update

- Extend the registry `/mcp` response with deterministic marketplace metadata: description, tool count, token labels, and interaction types derived from ABI mutability plus explicit native/Uniswap definitions. Treat blockchain network as the `platform`.
- Update `Mcp` mapping/types to use `platform`, `tokens`, and `interactionType` (`read-only`, `transactional`, or `mixed`) while retaining the existing chain fields needed by registration/config flows.
- Replace chain/tag/star controls with search plus platform, token, and interaction filters. Search covers name, description, platform, token, contract, and interaction label.
- Redesign cards into a compact identity row, two-line description, small metadata chips, and a restrained secondary assignment action. Remove the oversized stained-glass banner, fake star sorting/statistics, forced vertical whitespace, and console logging.
- Keep the existing detail drawer and list view only where they can display real fields; remove star-based presentation and align both views with the same metadata.
- Add localized labels and empty states in all existing dictionaries.

# 4. Agent chatbot update

- Do not implement chat UI, message persistence, model providers, or tool orchestration in this branch.
- Add `agent_mcp_binding(agent_id, mcp_name, bound_at)` with ownership-safe API operations under `/api/agents/[id]/mcps`.
- Enrich agent API responses with assigned MCP IDs and marketplace metadata. The profile agent list and PWA shell show assignments without changing Gianfranco's chatbot component.
- Add a server-only `agent-runtime` helper that resolves an owned agent's selected MCP endpoints and active bearer token. Its public response omits secrets, giving the future chatbot a stable handoff boundary.
- Change the marketplace modal from “select agent then copy” to an explicit assignment action; only assigned MCPs are presented as available to that agent.
- Enforce assignments in the Rust registry after bearer authentication, returning `403` for unassigned MCPs. Ownership checks and SQL parameters remain mandatory.

# 5. Per-agent PWA update

- Add `/{lang}/agents/{id}` as the authenticated, minimal agent app shell and future chatbot mount point. It shows agent identity, assigned MCPs, branding controls, and install status but no fake conversation.
- Serve an authenticated manifest at `/api/agents/[id]/manifest.webmanifest` with stable `id: /agents/{id}`, locale-aware `start_url`, standalone display, Orloj colors, generated description, and 192/512 PNG icon endpoints.
- Add `agent_app_branding` storage and `/api/agents/[id]/branding` GET/PUT operations for app-name and PNG override data.
- Render the manifest link with `crossorigin="use-credentials"` and private/no-store headers. Never cache agent pages, manifests, branding, or icon overrides in shared caches.
- Implement a client install control that captures `beforeinstallprompt`, calls `prompt()` only after a user click, handles `appinstalled`, hides when already installed, and provides a short browser-menu fallback when the event is unsupported.
- Do not add silent install, offline claims, push, background sync, or private-response caching.

# 6. Icon generation rules

- Generate 192px and 512px PNGs with Next.js `ImageResponse`: Orloj base mark in the center plus up to four deterministic MCP sub-icons based on assigned MCP names.
- If no MCP is assigned, use the Orloj base mark plus a neutral agent glyph. Ordering is stable by MCP name so identical input produces identical output.
- Accept optional PNG overrides only: maximum 1 MiB, 192–1024px square, valid PNG signature/IHDR, no APNG animation, no SVG, URLs, or remote fetches.
- Store override bytes privately. The rendered installed icon places the override inside an Orloj frame/mark so user customization cannot fully impersonate another app.
- Sanitize app names by trimming, rejecting control/bidirectional override characters, limiting length, and retaining an Orloj suffix in manifest names.

# 7. Landing page update

- Replace the single generic ETHPrague eyebrow with two localized badges:
  - `ETH Lisbon · participant`
  - `ETHPrague · hackathon winner`
- Do not describe ETH Lisbon as a win. Keep claims as dictionary content so event wording can be updated without component logic changes.
- Add translations for all six currently supported locales and preserve the existing visual language.

# 8. Minimal technical requirements

- Reuse React, Next.js, PostgreSQL, Rust/Axum, and `ImageResponse`; add no dependency.
- Update `packages/app/lib/db.ts` and registry DB access with idempotent schema creation/queries. All branding and assignment reads must join through `agent_ownership`.
- Validate registry metadata at the app boundary and provide safe fallbacks for older registry deployments during rollout.
- Use React text rendering/JSON serialization only; never inject registry metadata with raw HTML.
- Keep manifest/icon/app endpoints same-origin, authenticated, owner-checked, and `Cache-Control: private, no-store`.
- Update the Next proxy matcher only if required after verifying the generated routes; do not weaken authentication.

# 9. Risk review

- **Excessive card height / wasted space / oversized decorative banners:** remove the 80px banner and fixed 60px summary; cap summaries at two lines and use compact padding.
- **Weak contrast / unattractive icon-banner treatment:** use solid high-contrast card surfaces and bounded icons; retain accent colors only for small signals.
- **Poor mobile density / CTA overpowering content:** use one-column cards, compact filter controls, and a secondary-size assignment CTA below the MCP identity.
- **XSS/HTML/SVG injection:** render metadata as text, reject SVG uploads, and do not use `dangerouslySetInnerHTML`.
- **Unsafe icon upload / remote fetch / SSRF / path traversal:** accept bounded local PNG bytes only; never accept paths or URLs.
- **Manifest confusion / cache poisoning / cross-user leakage:** stable agent ID, ownership checks on every endpoint, credentialed manifest link, and private no-store responses.
- **Privilege confusion:** authorize `agent_id + mcp_name` in the registry, not only the bearer token.
- **Phishing-like app identity:** validate names, append Orloj identity, and frame custom icons with the Orloj mark.
- **Compatibility/regression:** tolerate absent new registry fields in the app mapper; deploy registry metadata before relying on populated filters.
- **Landing claims:** ETH Lisbon is participation only; ETHPrague is the winner claim. Final event wording remains subject to product-owner review.

# 10. Build order

1. Add registry metadata derivation/response fields and app-side safe mapping/types.
2. Redesign registry filters, cards, detail/list views, and translations.
3. Add agent-MCP persistence/API/runtime contract, wire marketplace assignment, and enforce it in Rust.
4. Add branding persistence, safe PNG validation, generated icon/manifest routes, and the authenticated agent PWA shell/install control.
5. Add localized ETH Lisbon participation and ETHPrague winner badges.
6. Run app lint/build and registry format/check/tests; manually verify desktop/mobile marketplace and PWA behavior.
7. Complete `docs/orloj-marketplace-agent-pwa-qa.md`, review the diff/security boundaries, commit coherent changes, push the branch, and open a PR against `main`.
