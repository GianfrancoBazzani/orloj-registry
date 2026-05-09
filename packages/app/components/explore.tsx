"use client";
import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "./auth-context";
import {
  Pill,
  Btn,
  Divider,
  Identicon,
  Tag,
  Input,
  Select,
  StainedPanel,
} from "./ornaments";
import { MCP_REGISTRY, SHORT_ADDR, type Mcp } from "./data";

export const Explore = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, setShowLogin } = useAuth();
  const onNavigate = (r: string) => router.push(r === "home" ? "/" : `/${r}`);
  const onBind = (m: Mcp) => {
    if (!user) { setShowLogin(true); return; }
    router.push(`/profile?bind=${m.id}`);
  };
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");

  useEffect(() => {
    const param = searchParams.get("q");
    if (param !== null) setQ(param);
  }, [searchParams]);
  const [chain, setChain] = useState("All chains");
  const [tag, setTag] = useState("All capabilities");
  const [sort, setSort] = useState("Most active");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Mcp | null>(null);

  const allTags = [
    "All capabilities",
    ...new Set(MCP_REGISTRY.flatMap((m) => m.tags)),
  ];
  const allChains = [
    "All chains",
    ...new Set(MCP_REGISTRY.map((m) => m.chain)),
  ];

  let list = MCP_REGISTRY.filter((m) => {
    if (
      q &&
      !`${m.name} ${m.summary} ${m.author} ${m.tags.join(" ")}`
        .toLowerCase()
        .includes(q.toLowerCase())
    )
      return false;
    if (chain !== "All chains" && m.chain !== chain) return false;
    if (tag !== "All capabilities" && !m.tags.includes(tag)) return false;
    return true;
  });
  if (sort === "Most active")
    list = [...list].sort((a, b) => b.callsLast24h - a.callsLast24h);
  if (sort === "Most starred")
    list = [...list].sort((a, b) => b.stars - a.stars);
  if (sort === "Recently added") list = [...list].reverse();

  return (
    <main style={{ padding: "40px 32px 80px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            flexWrap: "wrap",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <div>
            <Pill tone="verdigris" style={{ marginBottom: 10 }}>
              operators&apos; gate
            </Pill>
            <h1
              className="display"
              style={{
                fontSize: "clamp(36px, 5vw, 56px)",
                margin: 0,
                lineHeight: 1,
              }}
            >
              The Registry
            </h1>
            <p
              className="poetic"
              style={{
                fontSize: 20,
                color: "var(--ink-soft)",
                marginTop: 8,
                marginBottom: 0,
              }}
            >
              {list.length} of {MCP_REGISTRY.length} interfaces — bound by
              manifests, not promises.
            </p>
          </div>
          <Btn kind="brass" onClick={() => onNavigate("register")}>
            + Publish your own
          </Btn>
        </div>

        <Divider />

        {/* Filter rail */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr repeat(3, 1fr) auto",
            gap: 12,
            padding: "20px 0",
            alignItems: "center",
          }}
        >
          <div style={{ position: "relative" }}>
            <Input
              placeholder="Search by name, ENS, capability…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--ink-soft)",
              }}
            >
              ⌕
            </span>
          </div>
          <Select value={chain} onChange={setChain} options={allChains} />
          <Select value={tag} onChange={setTag} options={allTags} />
          <Select
            value={sort}
            onChange={setSort}
            options={["Most active", "Most starred", "Recently added"]}
          />
          <div
            style={{
              display: "flex",
              gap: 4,
              border: "1px solid var(--line)",
              padding: 2,
            }}
          >
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="smallcaps"
                style={{
                  padding: "8px 12px",
                  fontSize: 11,
                  border: "none",
                  cursor: "pointer",
                  background:
                    view === v ? "var(--ink)" : "transparent",
                  color:
                    view === v ? "var(--parchment)" : "var(--ink-soft)",
                  fontFamily: "var(--font-ui)",
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Tag chip rail */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            paddingBottom: 24,
          }}
        >
          {allTags.slice(0, 10).map((t) => (
            <button
              key={t}
              onClick={() => setTag(t)}
              className="smallcaps"
              style={{
                padding: "6px 12px",
                fontSize: 11,
                fontFamily: "var(--font-ui)",
                background: tag === t ? "var(--brass)" : "transparent",
                color: tag === t ? "var(--ink)" : "var(--ink-soft)",
                border: `1px solid ${
                  tag === t ? "var(--brass-deep)" : "var(--line)"
                }`,
                cursor: "pointer",
                letterSpacing: "0.16em",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Listing */}
        {view === "grid" ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: 20,
            }}
          >
            {list.map((m) => (
              <MCPCard
                key={m.id}
                m={m}
                onClick={() => setSelected(m)}
                onBind={() => onBind(m)}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--line)",
              background: "rgba(241,233,212,0.4)",
            }}
          >
            <div
              className="smallcaps"
              style={{
                display: "grid",
                gridTemplateColumns: "2.5fr 1.4fr 1fr 1fr 1fr 0.8fr",
                gap: 12,
                padding: "12px 16px",
                fontSize: 11,
                color: "var(--ink-soft)",
                borderBottom: "1px solid var(--line)",
                background: "var(--parchment-3)",
              }}
            >
              <div>Interface</div>
              <div>Author</div>
              <div>Chain</div>
              <div>Calls / 24h</div>
              <div>Audits</div>
              <div />
            </div>
            {list.map((m) => (
              <div
                key={m.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2.5fr 1.4fr 1fr 1fr 1fr 0.8fr",
                  gap: 12,
                  padding: "14px 16px",
                  alignItems: "center",
                  borderBottom: "1px solid var(--line-soft)",
                  cursor: "pointer",
                }}
                onClick={() => setSelected(m)}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background =
                    "rgba(184,137,58,0.08)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <div
                  style={{ display: "flex", gap: 10, alignItems: "center" }}
                >
                  <Identicon seed={m.id} size={32} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {m.name}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-soft)" }}
                    >
                      {SHORT_ADDR(m.contract)}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "var(--verdigris-deep)" }}>
                  {m.author}
                </div>
                <div style={{ fontSize: 13 }}>{m.chain}</div>
                <div className="mono" style={{ fontSize: 13 }}>
                  {m.callsLast24h.toLocaleString()}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {m.audits.length > 0 ? (
                    m.audits
                      .slice(0, 1)
                      .map((a) => (
                        <Tag key={a} color="var(--verdigris-deep)">
                          ✓ {a}
                        </Tag>
                      ))
                  ) : (
                    <Tag color="var(--wine)">unaudited</Tag>
                  )}
                  {m.audits.length > 1 && (
                    <Tag color="var(--ink-soft)">+{m.audits.length - 1}</Tag>
                  )}
                </div>
                <Btn
                  size="sm"
                  kind="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onBind(m);
                  }}
                >
                  Bind →
                </Btn>
              </div>
            ))}
          </div>
        )}

        {list.length === 0 && (
          <div
            style={{
              padding: 64,
              textAlign: "center",
              color: "var(--ink-soft)",
            }}
          >
            <div className="display" style={{ fontSize: 28 }}>
              The square is empty.
            </div>
            <p className="poetic" style={{ fontSize: 18, marginTop: 8 }}>
              No interfaces match those filters. Try fewer constraints.
            </p>
          </div>
        )}
      </div>

      {selected && (
        <DetailDrawer
          m={selected}
          onClose={() => setSelected(null)}
          onBind={() => {
            onBind(selected);
            setSelected(null);
          }}
        />
      )}
    </main>
  );
};

const MCPCard = ({
  m,
  onClick,
  onBind,
}: {
  m: Mcp;
  onClick: () => void;
  onBind: () => void;
}) => {
  const accent =
    m.color === "verdigris"
      ? "var(--verdigris)"
      : m.color === "brass"
      ? "var(--brass)"
      : m.color === "wine"
      ? "var(--wine)"
      : "var(--stained-blue)";
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        background: "rgba(241,233,212,0.55)",
        border: "1px solid var(--line)",
        cursor: "pointer",
        transition: "transform 0.18s, box-shadow 0.18s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translate(-2px,-2px)";
        e.currentTarget.style.boxShadow = `4px 4px 0 ${accent}`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div
        style={{
          height: 80,
          background: accent,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "absolute", inset: 0, opacity: 0.35 }}>
          <StainedPanel seed={m.id.length} width={400} height={80} />
        </div>
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 16,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <Identicon seed={m.id} size={36} />
        </div>
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            display: "flex",
            gap: 6,
          }}
        >
          {m.verified && (
            <Pill
              tone="brass"
              style={{ background: "rgba(241,233,212,0.95)" }}
            >
              ✓ verified
            </Pill>
          )}
        </div>
      </div>

      <div style={{ padding: "16px 18px 18px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <div
            className="display"
            style={{ fontSize: 17, color: "var(--ink)" }}
          >
            {m.name}
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-soft)" }}
          >
            ★ {m.stars.toLocaleString()}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 4,
            fontSize: 12.5,
            color: "var(--verdigris-deep)",
          }}
        >
          <span>{m.author}</span>
          <span style={{ color: "var(--ink-soft)" }}>·</span>
          <span style={{ color: "var(--ink-soft)" }}>{m.chain}</span>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-soft)",
            marginTop: 10,
            lineHeight: 1.5,
            minHeight: 60,
          }}
        >
          {m.summary}
        </p>
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
        >
          {m.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px dashed var(--line)",
          }}
        >
          <div>
            <div
              className="smallcaps"
              style={{ fontSize: 10, color: "var(--ink-soft)" }}
            >
              tools
            </div>
            <div className="mono" style={{ fontSize: 14 }}>
              {m.interfaces}
            </div>
          </div>
          <div>
            <div
              className="smallcaps"
              style={{ fontSize: 10, color: "var(--ink-soft)" }}
            >
              calls / 24h
            </div>
            <div className="mono" style={{ fontSize: 14 }}>
              {m.callsLast24h.toLocaleString()}
            </div>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <Btn
              size="sm"
              kind="primary"
              onClick={(e) => {
                e.stopPropagation();
                onBind();
              }}
            >
              Bind →
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
};

const DetailDrawer = ({
  m,
  onClose,
  onBind,
}: {
  m: Mcp;
  onClose: () => void;
  onBind: () => void;
}) => (
  <div
    onClick={onClose}
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(26,22,18,0.5)",
      zIndex: 50,
      display: "flex",
      justifyContent: "flex-end",
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width: "min(640px, 100%)",
        background: "var(--parchment)",
        overflowY: "auto",
        borderLeft: "4px solid var(--brass)",
        boxShadow: "-12px 0 40px rgba(0,0,0,0.2)",
      }}
    >
      <div
        style={{
          height: 140,
          background: "var(--verdigris-deep)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "absolute", inset: 0, opacity: 0.4 }}>
          <StainedPanel seed={m.id.length + 5} width={640} height={140} />
        </div>
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "var(--parchment)",
            border: "none",
            cursor: "pointer",
            fontSize: 20,
            color: "var(--ink)",
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: "24px 32px 40px" }}>
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "flex-start",
          }}
        >
          <Identicon seed={m.id} size={56} />
          <div style={{ flex: 1 }}>
            <h2 className="display" style={{ fontSize: 30, margin: 0 }}>
              {m.name}
            </h2>
            <div
              style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}
            >
              by{" "}
              <span style={{ color: "var(--verdigris-deep)" }}>
                {m.author}
              </span>{" "}
              · on {m.chain}
            </div>
          </div>
        </div>
        <p
          className="poetic"
          style={{
            fontSize: 18,
            color: "var(--ink)",
            marginTop: 16,
            lineHeight: 1.5,
          }}
        >
          {m.summary}
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            marginTop: 24,
          }}
        >
          {[
            ["Tool surface", `${m.interfaces} tools`],
            ["Calls / 24h", m.callsLast24h.toLocaleString()],
            ["Stars", m.stars.toLocaleString()],
          ].map(([l, v]) => (
            <div
              key={l}
              style={{
                padding: 12,
                background: "rgba(255,255,255,0.4)",
                border: "1px solid var(--line)",
              }}
            >
              <div
                className="smallcaps"
                style={{ fontSize: 10, color: "var(--ink-soft)" }}
              >
                {l}
              </div>
              <div className="display" style={{ fontSize: 22, marginTop: 4 }}>
                {v}
              </div>
            </div>
          ))}
        </div>

        <h4
          className="smallcaps"
          style={{ marginTop: 24, color: "var(--ink-soft)", fontSize: 11 }}
        >
          contract
        </h4>
        <div
          className="mono"
          style={{
            padding: 12,
            background: "var(--ink)",
            color: "var(--brass-bright)",
            fontSize: 12,
            marginTop: 6,
            wordBreak: "break-all",
          }}
        >
          {m.contract}
        </div>

        <h4
          className="smallcaps"
          style={{ marginTop: 24, color: "var(--ink-soft)", fontSize: 11 }}
        >
          capabilities
        </h4>
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
        >
          {m.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>

        <h4
          className="smallcaps"
          style={{ marginTop: 24, color: "var(--ink-soft)", fontSize: 11 }}
        >
          audits
        </h4>
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
        >
          {m.audits.length > 0 ? (
            m.audits.map((a) => (
              <Tag key={a} color="var(--verdigris-deep)">
                ✓ {a}
              </Tag>
            ))
          ) : (
            <Tag color="var(--wine)">No audits filed</Tag>
          )}
        </div>

        <h4
          className="smallcaps"
          style={{ marginTop: 24, color: "var(--ink-soft)", fontSize: 11 }}
        >
          example tool
        </h4>
        <pre
          className="mono"
          style={{
            padding: 16,
            background: "var(--ink)",
            color: "var(--parchment)",
            fontSize: 12,
            marginTop: 6,
            lineHeight: 1.6,
            overflow: "auto",
            borderRadius: 0,
          }}
        >{`{
  "name": "${m.tags[0]?.toLowerCase() || "execute"}.quote",
  "params": { "tokenIn": "address", "tokenOut": "address", "amount": "uint256" },
  "scope": "read",
  "rate_limit": "30 / minute"
}`}</pre>

        <div style={{ display: "flex", gap: 12, marginTop: 32 }}>
          <Btn kind="primary" size="lg" onClick={onBind}>
            Bind to agent →
          </Btn>
          <Btn kind="ghost" size="lg">
            View manifest
          </Btn>
        </div>
      </div>
    </div>
  </div>
);
