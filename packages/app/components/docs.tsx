"use client";
import { Pill, Divider } from "./ornaments";
import { useT } from "./i18n-context";

export const DocsPage = () => {
  const t = useT();

  const cards = [
    { t: t("docs.card1Title"), d: t("docs.card1Desc"), l: "orloj.manifest" },
    { t: t("docs.card2Title"), d: t("docs.card2Desc"), l: "/quickstart" },
    { t: t("docs.card3Title"), d: t("docs.card3Desc"), l: "/builders" },
    { t: t("docs.card4Title"), d: t("docs.card4Desc"), l: "/vaults" },
    { t: t("docs.card5Title"), d: t("docs.card5Desc"), l: "/api" },
    { t: t("docs.card6Title"), d: t("docs.card6Desc"), l: "/glossary" },
  ];

  return (
    <main className="page-pad" style={{ padding: "60px 32px 80px", maxWidth: 900, margin: "0 auto" }}>
      <Pill tone="brass">{t("docs.pill")}</Pill>
      <h1 className="display" style={{ fontSize: 56, margin: "14px 0 8px" }}>
        {t("docs.title")}
      </h1>
      <p
        className="poetic"
        style={{ fontSize: 22, color: "var(--ink-soft)", margin: 0 }}
      >
        {t("docs.subtitle")}
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
        {cards.map((d) => (
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
