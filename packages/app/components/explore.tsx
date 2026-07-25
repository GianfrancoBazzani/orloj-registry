"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Btn,
  Divider,
  Identicon,
  Tag,
  Input,
  Select,
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

  const ALL_PLATFORMS = t("explore.allPlatforms");
  const ALL_TOKENS = t("explore.allTokens");
  const ALL_INTERACTIONS = t("explore.allInteractions");

  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState(ALL_PLATFORMS);
  const [token, setToken] = useState(ALL_TOKENS);
  const [interaction, setInteraction] = useState(ALL_INTERACTIONS);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Mcp | null>(null);

  // List view's table doesn't fit phone widths — force grid below 768px.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => { if (mq.matches) setView("grid"); };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const allPlatforms = [
    ALL_PLATFORMS,
    ...new Set(mcps.map((m) => m.platform)),
  ];
  const allTokens = [
    ALL_TOKENS,
    ...new Set(mcps.flatMap((m) => m.tokens)),
  ];
  const interactionOptions = [
    ALL_INTERACTIONS,
    t("explore.interactionReadOnly"),
    t("explore.interactionTransactional"),
    t("explore.interactionMixed"),
  ];

  const list = mcps.filter((m) => {
    const interactionLabel = t(
      m.interactionType === "read-only"
        ? "explore.interactionReadOnly"
        : m.interactionType === "transactional"
          ? "explore.interactionTransactional"
          : "explore.interactionMixed",
    );
    if (
      q &&
      !`${m.name} ${m.summary} ${m.author} ${m.platform} ${m.tokens.join(" ")} ${interactionLabel} ${m.contract}`
        .toLowerCase()
        .includes(q.toLowerCase())
    )
      return false;
    if (platform !== ALL_PLATFORMS && m.platform !== platform) return false;
    if (token !== ALL_TOKENS && !m.tokens.includes(token)) return false;
    if (interaction !== ALL_INTERACTIONS && interactionLabel !== interaction)
      return false;
    return true;
  });

  return (
    <main className="page-pad" style={{ padding: "40px 32px 80px" }}>
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
          className="explore-filters"
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr repeat(3, 1fr) auto",
            gap: 12,
            padding: "20px 0",
            alignItems: "center",
          }}
        >
          <div className="explore-search" style={{ position: "relative" }}>
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
          <Select
            value={platform}
            onChange={setPlatform}
            options={allPlatforms}
          />
          <Select value={token} onChange={setToken} options={allTokens} />
          <Select
            value={interaction}
            onChange={setInteraction}
            options={interactionOptions}
          />
          <div
            className="explore-view-toggle"
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

        {/* Listing */}
        {view === "grid" ? (
          <div
            className="explore-grid"
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
                onPlatformClick={(value) => setPlatform(value)}
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
                {([
                  t("explore.interfaceColumn"),
                  t("explore.platformColumn"),
                  t("explore.tokenColumn"),
                  t("explore.interactionColumn"),
                ] as const).map(
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
                    {m.platform}
                  </td>
                  <td style={{ padding: "14px 16px", fontSize: 13 }}>
                    {m.tokens.join(", ") || t("explore.noToken")}
                  </td>
                  <td style={{ padding: "14px 16px", fontSize: 13 }}>
                    {t(
                      m.interactionType === "read-only"
                        ? "explore.interactionReadOnly"
                        : m.interactionType === "transactional"
                          ? "explore.interactionTransactional"
                          : "explore.interactionMixed",
                    )}
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
                      {t("explore.connectAgent")} →
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
  onPlatformClick,
}: {
  m: Mcp;
  onClick: () => void;
  onAddMcp: () => void;
  onPlatformClick: (platform: string) => void;
}) => {
  const t = useT();
  const accent =
    m.color === "verdigris"
      ? "var(--verdigris)"
      : m.color === "brass"
      ? "var(--brass)"
      : m.color === "wine"
      ? "var(--wine)"
      : "var(--stained-blue)";
  const interactionLabel = t(
    m.interactionType === "read-only"
      ? "explore.interactionReadOnly"
      : m.interactionType === "transactional"
        ? "explore.interactionTransactional"
        : "explore.interactionMixed",
  );
  return (
    <div
      onClick={onClick}
      className="mcp-card"
      style={{
        position: "relative",
        background: "rgba(241,233,212,0.55)",
        border: "1px solid var(--line)",
        padding: 18,
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
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div
          style={{
            padding: 3,
            background: "var(--parchment)",
            border: `2px solid ${accent}`,
            flex: "0 0 auto",
          }}
        >
          <Identicon seed={m.id} size={42} />
        </div>
        <div
          style={{
            minWidth: 0,
            flex: 1,
          }}
        >
          <div
            className="display"
            title={m.name}
            style={{
              fontSize: 18,
              color: "var(--ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {m.name}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--ink-soft)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {m.contract ? SHORT_ADDR(m.contract) : m.author}
          </div>
        </div>
        <div style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "45%" }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlatformClick(m.platform);
            }}
            className="smallcaps"
            style={{
              display: "block",
              maxWidth: "100%",
              padding: "4px 8px",
              borderRadius: 999,
              background: "var(--parchment-2)",
              color: "var(--ink)",
              border: "1px solid var(--line)",
              fontFamily: "var(--font-ui)",
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: "0.1em",
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={t("explore.filterByPlatform", { platform: m.platform })}
          >
            {m.platform}
          </button>
        </div>
      </div>

      <p
        style={{
          fontSize: 13,
          color: "var(--ink-soft)",
          margin: "12px 0 0",
          lineHeight: 1.45,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {m.summary}
      </p>

      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <Tag>{interactionLabel}</Tag>
        {m.tokens.slice(0, 2).map((value) => (
          <Tag key={value}>{value}</Tag>
        ))}
        <Tag>{t("explore.toolsCount", { count: m.interfaces })}</Tag>
      </div>

      <div
        className="mcp-card-footer"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginTop: 14,
          paddingTop: 12,
          borderTop: "1px dashed var(--line)",
        }}
      >
        <span
          className="smallcaps"
          style={{ fontSize: 9, color: "var(--ink-soft)" }}
        >
          {m.tokens.length > 0
            ? t("explore.tokenLabel", { token: m.tokens.join(", ") })
            : t("explore.noToken")}
        </span>
        <Btn
          size="sm"
          kind="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onAddMcp();
          }}
        >
          {t("explore.connectAgent")} →
        </Btn>
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
}) => {
  const t = useT();
  const interactionLabel = t(
    m.interactionType === "read-only"
      ? "explore.interactionReadOnly"
      : m.interactionType === "transactional"
        ? "explore.interactionTransactional"
        : "explore.interactionMixed",
  );
  return (
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
      className="detail-drawer"
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
          height: 54,
          background: "var(--ink)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 9,
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
              · {m.platform}
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
          className="detail-metrics"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            marginTop: 24,
          }}
        >
          {[
            [t("explore.toolSurface"), t("explore.toolsCount", { count: m.interfaces })],
            [t("explore.platformColumn"), m.platform],
            [t("explore.interactionColumn"), interactionLabel],
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
          {t("explore.tokensTitle")}
        </h4>
        <div
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
        >
          {m.tokens.length > 0 ? (
            m.tokens.map((token) => <Tag key={token}>{token}</Tag>)
          ) : (
            <Tag>{t("explore.noToken")}</Tag>
          )}
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
            {t("explore.connectAgent")} →
          </Btn>
        </div>
      </div>
    </div>
    </div>
  );
};
