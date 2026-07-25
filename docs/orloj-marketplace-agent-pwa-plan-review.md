# Plan critique

The plan is scoped to the requested marketplace, assignment contract, per-agent PWA, and landing claims. It correctly avoids building Gianfranco's chat runtime and avoids app-store extras. The strongest implementation dependency is deployment order: registry authorization must not go live before the app can create and populate agent assignments.

The marketplace metadata also needs deterministic fallbacks. Contract ABIs do not reliably reveal a human token symbol, and calling arbitrary contracts during listing would add latency and attack surface. Token labels must therefore come from native-token metadata, known built-in MCP metadata, or a conservative ERC-20 contract-name fallback; generic contracts should use no token label rather than an invented value.

# Scope-creep check

- Remove current star sorting/statistics because it behaves like rating/popularity data and live values are fake; do not replace it with another ranking system.
- Do not add chat messages, LLM providers, conversation persistence, offline mode, notifications, PWA screenshots, analytics, publisher profiles, or recommendation logic.
- Keep the agent PWA page as an integration shell with assigned MCPs and branding/install controls.
- Do not refactor the large profile component beyond the assignment data it must display and the existing bind-on-create flow.

# Likely bugs and regressions

- `user_mcp_binding` currently powers profile metrics. Replace those reads with distinct `agent_mcp_binding` rows joined through `agent_ownership`; otherwise metrics become stale.
- The create-agent flow currently shows a selected MCP but never binds it. The corrected flow must create the agent, create its key grant, then bind the MCP; if binding fails, report the partial state rather than deleting a valid agent/key grant unexpectedly.
- Existing registry and app deployments may briefly disagree on new marketplace fields. The app mapper must tolerate absent fields; registry authorization deployment must follow the assignment-capable app deployment.
- Manifest identity must use both a unique `id` and unique `start_url`, because browsers without reliable `id` support fall back to `start_url`.
- Authenticated manifests require a credentialed link. The page should render the link directly with `crossOrigin="use-credentials"` rather than relying only on `generateMetadata`.
- `ImageResponse` code should remain in a recognized `route.ts` file by constructing React elements without requiring a nonstandard route filename.
- Agent names come from an upstream service. Manifest JSON and React rendering must serialize them as data, never markup.

# Security review

- Every assignment, branding, manifest, icon, and agent-shell read must first assert `agent_ownership`; non-owners receive indistinguishable 404 responses.
- Registry authorization must query `agent_mcp_binding` with both authenticated `agent_id` and route `mcp_name`, including the fixed `uniswap` route, and return 403 without revealing another user's data.
- Public runtime/context responses must not contain bearer tokens. Only a server-only helper may resolve the active token for future chatbot orchestration.
- PNG validation must reject oversized, nonsquare, animated, malformed, SVG, URL, and remote content. Keep upload and dimension bounds before `ImageResponse` parses bytes.
- Manifest/icon/app responses are private and `no-store`; no service worker or shared cache is added, preventing private content from being cached across users.
- App names reject control and bidirectional override characters. Custom icons retain an Orloj frame/mark to reduce app-identity spoofing.
- Registry descriptions, token labels, and contract names are rendered through React/JSON only; no HTML/SVG string interpolation or remote metadata fetch is allowed.
- SQL uses parameters and ownership joins; route IDs are never converted to filesystem paths.

# Missing technical requirements and minimal corrections

- Add a small `lib/agent-mcps.ts` module for assignment queries, ownership-safe listing, and the server-only runtime contract instead of duplicating SQL in UI routes.
- Add a `lib/agent-branding.ts` module for name validation, PNG validation, branding reads/writes, and deterministic default text.
- Add explicit `GET/POST/DELETE /api/agents/[id]/mcps`; POST assigns one validated registry MCP name and DELETE removes one. Validate both EVM/native IDs and the built-in `uniswap` ID.
- Update `/api/agents` to batch-load bindings for owned agents and return `mcps`; update metrics to use the same table.
- Generate description/tool/interaction metadata inside the registry without network calls. For EVM contracts derive read/write from ABI state mutability; native and Uniswap definitions are explicit.
- Use `Cache-Control: private, no-store`, `Content-Security-Policy: default-src 'none'; img-src 'self' data:` on image/manifest responses where applicable, and `X-Content-Type-Options: nosniff`.
- Omit a service worker: current installability requires manifest/HTTPS/icons, not offline behavior, and adding a worker would create unnecessary private-cache risk. Unsupported install-prompt browsers get concise manual instructions.
- Add pure validation/metadata unit tests where practical, then run the repository's existing lint/build/check commands and manual authenticated PWA checks.

# Final corrected execution checklist

1. Add marketplace metadata to Rust `/mcp`, including deterministic descriptions, real tool counts, platform, token labels, and read-only/transactional/mixed classification.
2. Map new fields safely in Next.js and replace registry filters/cards/detail/list content; remove banner waste, fake stars, and dominant CTAs.
3. Add `agent_mcp_binding`, owner-scoped assignment APIs/helpers, agent response enrichment, profile metrics migration, existing-agent assignment in the launch modal, and bind-on-create behavior.
4. Enforce `agent_id + mcp_name` in both Rust MCP handlers, with an explicit coordinated-deployment note.
5. Add owner-scoped branding storage/validation, credentialed per-agent manifests, deterministic 192/512 PNG generation, and a minimal authenticated agent PWA integration shell with install control.
6. Add all-locale ETH Lisbon participant and ETHPrague winner badges.
7. Run formatting, lint, build, Rust checks/tests, security review, and desktop/mobile/PWA manual checks; record results and gaps in the required QA artifact.
8. Commit coherent changes, push `codex/orloj-marketplace-agent-pwa`, and open one PR to `main`.
