"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { SHORT_ADDR, type Mcp } from "./data";
import { LaunchModal, type RegisterResult } from "./launch-modal";
import { useT, useLocale } from "./i18n-context";

export const Explore = ({ mcps }: { mcps: Mcp[] }) => {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  const onNavigate = (r: string) =>
    router.push(r === "home" ? `/${locale}` : `/${locale}/${r}`);
  const [launchMcp, setLaunchMcp] = useState<RegisterResult | null>(null);
  const openLaunchModal = (m: Mcp) => {
    setLaunchMcp({
      name: m.id,
      contractName: m.name,
      mcpUrl: m.mcpUrl,
      chainId: m.chainId,
      address: m.contract || false,
    });
  };

  const ALL_CHAINS = t("explore.allChains");
  const ALL_CAPS = t("explore.allCapabilities");
  const SORT_ACTIVE = t("explore.sortActive");
  const SORT_STARRED = t("explore.sortStarred");
  const SORT_RECENT = t("explore.sortRecent");

  const [q, setQ] = useState("");
  const [chain, setChain] = useState(ALL_CHAINS);
  const [tag, setTag] = useState(ALL_CAPS);
  const [sort, setSort] = useState(SORT_ACTIVE);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Mcp | null>(null);

  const allTags = [ALL_CAPS, ...new Set(mcps.flatMap((m) => m.tags))];
  const allChains = [ALL_CHAINS, ...new Set(mcps.map((m) => m.chain))];

  let list = mcps.filter((m) => {
    if (
      q &&
      !`${m.name} ${m.summary} ${m.author} ${m.tags.join(" ")}`
        .toLowerCase()
        .includes(q.toLowerCase())
    )
      return false;
    if (chain !== ALL_CHAINS && m.chain !== chain) return false;
    if (tag !== ALL_CAPS && !m.tags.includes(tag)) return false;
    return true;
  });

  console.log(list);

  if (sort === SORT_ACTIVE)
    list = [...list].sort((a, b) => b.callsLast24h - a.callsLast24h);
  if (sort === SORT_STARRED)
    list = [...list].sort((a, b) => b.stars - a.stars);
  if (sort === SORT_RECENT) list = [...list].reverse();

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
            <h1
              className="display"
              style={{
                fontSize: "clamp(36px, 5vw, 56px)",
                margin: 0,
                lineHeight: 1,
              }}
            >
              {t("explore.title")}
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
              {t("explore.subtitle", { count: list.length, total: mcps.length })}
            </p>
          </div>
          <Btn kind="brass" onClick={() => { onNavigate("register"); }}>
            {t("explore.publishOwn")}
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
              placeholder={t("explore.searchPlaceholder")}
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
            options={[SORT_ACTIVE, SORT_STARRED, SORT_RECENT]}
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
                {v === "grid" ? t("explore.viewGrid") : t("explore.viewList")}
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
                onAddMcp={() => openLaunchModal(m)}
              />
            ))}
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              border: "1px solid var(--line)",
              background: "rgba(241,233,212,0.4)",
            }}
          >
            <colgroup>
              <col style={{ width: "35%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr
                style={{
                  background: "var(--parchment-3)",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                {(["Interface", "Author", "Chain", "Calls / 24h"] as const).map(
                  (h) => (
                    <th
                      key={h}
                      className="smallcaps"
                      style={{
                        padding: "12px 16px",
                        fontSize: 11,
                        color: "var(--ink-soft)",
                        fontWeight: 400,
                        textAlign: "left",
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr
                  key={m.id}
                  style={{ borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}
                  onClick={() => setSelected(m)}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "rgba(184,137,58,0.08)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <td style={{ padding: "14px 16px" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                  </td>
                  <td
                    style={{
                      padding: "14px 16px",
                      fontSize: 13,
                      color: "var(--verdigris-deep)",
                    }}
                  >
                    {m.author}
                  </td>
                  <td style={{ padding: "14px 16px", fontSize: 13 }}>
                    {m.chain}
                  </td>
                  <td className="mono" style={{ padding: "14px 16px", fontSize: 13 }}>
                    {m.callsLast24h.toLocaleString()}
                  </td>
                  <td style={{ padding: "14px 16px", textAlign: "right" }}>
                    <Btn
                      size="sm"
                      kind="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        openLaunchModal(m);
                      }}
                    >
                      Add MCP →
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          onAddMcp={() => {
            openLaunchModal(selected);
            setSelected(null);
          }}
        />
      )}
      {launchMcp && (
        <LaunchModal result={launchMcp} onCloseAction={() => setLaunchMcp(null)} />
      )}
    </main>
  );
};

const MCPCard = ({
  m,
  onClick,
  onAddMcp,
}: {
  m: Mcp;
  onClick: () => void;
  onAddMcp: () => void;
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
                onAddMcp();
              }}
            >
              Add MCP →
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
  onAddMcp,
}: {
  m: Mcp;
  onClose: () => void;
  onAddMcp: () => void;
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

        {m.contract && (
          <>
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
          </>
        )}

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

        {m.audits.length > 0 && (
          <>
            <h4
              className="smallcaps"
              style={{ marginTop: 24, color: "var(--ink-soft)", fontSize: 11 }}
            >
              audits
            </h4>
            <div
              style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
            >
              {m.audits.map((a) => (
                <Tag key={a} color="var(--verdigris-deep)">
                  ✓ {a}
                </Tag>
              ))}
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 32 }}>
          <Btn kind="brass" size="lg" onClick={onAddMcp}>
            Add MCP →
          </Btn>
        </div>
      </div>
    </div>
  </div>
);
