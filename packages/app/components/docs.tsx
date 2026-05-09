import { Pill, Divider } from "./ornaments";

export const DocsPage = () => {
  return (
    <main style={{ padding: "60px 32px 80px", maxWidth: 900, margin: "0 auto" }}>
      <Pill tone="brass">documentation</Pill>
      <h1 className="display" style={{ fontSize: 56, margin: "14px 0 8px" }}>
        Manuals & Manifests
      </h1>
      <p
        className="poetic"
        style={{ fontSize: 22, color: "var(--ink-soft)", margin: 0 }}
      >
        The mechanism, written down.
      </p>

      <Divider />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
          marginTop: 32,
        }}
      >
        {[
          {
            t: "Manifest schema",
            d: "EIP-712 typed data, optional capabilities tree, audit attestations.",
            l: "orloj.manifest/v0.4",
          },
          {
            t: "Operator quickstart",
            d: "Bind your first MCP, set spend policies, watch the trace.",
            l: "/quickstart",
          },
          {
            t: "Builder quickstart",
            d: "From verified address to public listing in 90 seconds.",
            l: "/builders",
          },
          {
            t: "Vault providers",
            d: "Turnkey, Fireblocks, Lit Protocol, Privy, self-custody.",
            l: "/vaults",
          },
          {
            t: "API reference",
            d: "REST + JSON-RPC over the indexer. Webhooks & EventSource.",
            l: "/api",
          },
          {
            t: "Glossary",
            d: "MCP, manifest, vault, agent, scope, strike.",
            l: "/glossary",
          },
        ].map((d) => (
          <div
            key={d.t}
            style={{
              padding: 18,
              background: "rgba(241,233,212,0.55)",
              border: "1px solid var(--line)",
              cursor: "pointer",
            }}
          >
            <div className="display" style={{ fontSize: 16 }}>
              {d.t}
            </div>
            <p
              style={{
                fontSize: 13,
                color: "var(--ink-soft)",
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              {d.d}
            </p>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--brass-deep)", marginTop: 8 }}
            >
              {d.l} →
            </div>
          </div>
        ))}
      </div>
    </main>
  );
};
