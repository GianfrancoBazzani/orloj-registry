"use client";
import { useRouter } from "next/navigation";
import {
  Pill,
  Btn,
  Divider,
  SectionHeader,
  ArtNouveauArch,
  StainedPanel,
  OrlojMark,
  GearIcon,
} from "./ornaments";

export const Landing = () => {
  const router = useRouter();
  const onNavigate = (r: string) => router.push(r === "home" ? "/" : `/${r}`);
const stats = [
    { v: "142", l: "registered MCPs" },
    { v: "38", l: "chains indexed" },
    { v: "1.2M", l: "tool calls / day" },
    { v: "17", l: "audit firms" },
  ];

  return (
    <main>
      {/* HERO */}
      <section style={{ position: "relative", padding: "64px 32px 24px" }}>
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)",
            gap: 56,
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                marginBottom: 22,
              }}
            >
              <Pill tone="brass">✦ ethprague · 2026 cohort</Pill>
              <Pill tone="verdigris">live on mainnet</Pill>
            </div>
            <h1
              className="display"
              style={{
                fontSize: "clamp(44px, 7vw, 88px)",
                lineHeight: 0.98,
                margin: 0,
                color: "var(--ink)",
                letterSpacing: "0.01em",
              }}
            >
              The astronomical
              <br />
              <span
                style={{
                  fontStyle: "italic",
                  fontFamily: "var(--font-poetic)",
                  fontWeight: 500,
                  color: "var(--brass-deep)",
                }}
              >
                registry{" "}
              </span>
              for smart
              <br />
              interfaces.
            </h1>
            <p
              className="poetic"
              style={{
                fontSize: "clamp(18px, 1.8vw, 22px)",
                color: "var(--ink-soft)",
                maxWidth: 560,
                marginTop: 22,
                lineHeight: 1.5,
              }}
            >
              ORLOJ is a public, audited index of{" "}
              <em>Model Context Protocol</em> servers wired to on‑chain
              contracts. Publish yours; or browse a thousand and let your agent
              ring the bells.
            </p>
            <div
              style={{
                display: "flex",
                gap: 14,
                marginTop: 32,
                flexWrap: "wrap",
              }}
            >
              <Btn kind="primary" size="lg" onClick={() => onNavigate("register")}>
                Register an MCP &nbsp;→
              </Btn>
              <Btn kind="ghost" size="lg" onClick={() => onNavigate("explore")}>
                Explore the registry
              </Btn>
            </div>
            <div
              style={{
                marginTop: 36,
                display: "flex",
                gap: 28,
                color: "var(--ink-soft)",
                fontSize: 13,
                flexWrap: "wrap",
              }}
            >
              <span>✶ Free to publish</span>
              <span>✶ EIP‑712 signed manifests</span>
              <span>✶ No custody</span>
            </div>
          </div>

          <div
            style={{
              position: "relative",
              height: 520,
              display: "grid",
              placeItems: "center",
            }}
          >
            <ClockTableau />
          </div>
        </div>
      </section>

      <Divider />

      {/* TWO FORKS */}
      <section style={{ padding: "56px 32px 32px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <SectionHeader
            eyebrow="two paths through the square"
            title="Bring an interface, or take one home."
            subtitle="The registry forks here. Builders publish; operators browse and bind. Choose your gate."
            align="center"
          />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
              gap: 28,
              marginTop: 44,
            }}
          >
            <ForkCard
              tone="brass"
              kicker="01 — Builders' gate"
              title="Register a new MCP"
              body="Paste a verified contract address. ORLOJ derives the ABI, generates a tool manifest, runs static checks, and lists it under your ENS. Takes about ninety seconds."
              bullets={[
                "Auto‑ABI from Sourcify",
                "EIP‑712 manifest signing",
                "Audit attestations",
                "Public + private listings",
              ]}
              cta="Open the wizard"
              onClick={() => onNavigate("register")}
              illustration={<RegisterIllustration />}
            />
            <ForkCard
              tone="verdigris"
              kicker="02 — Operators' gate"
              title="Explore registered MCPs"
              body="Search 142 published interfaces by chain, capability, audit posture, and call volume. Bind any to one of your agents in two clicks."
              bullets={[
                "Filter by capability tag",
                "See live call traffic",
                "Inspect manifest before binding",
                "One‑click agent binding",
              ]}
              cta="Browse the registry"
              onClick={() => onNavigate("explore")}
              illustration={<ExploreIllustration />}
            />
          </div>
        </div>
      </section>

      {/* STATS BAND */}
      <section style={{ padding: "40px 32px" }}>
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            borderTop: "1px solid var(--line)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
            }}
          >
            {stats.map((s, i) => (
              <div
                key={i}
                style={{
                  padding: "28px 20px",
                  borderLeft: i === 0 ? "none" : "1px solid var(--line)",
                  textAlign: "center",
                }}
              >
                <div
                  className="display"
                  style={{
                    fontSize: "clamp(28px, 3.6vw, 44px)",
                    color: "var(--ink)",
                    lineHeight: 1,
                  }}
                >
                  {s.v}
                </div>
                <div
                  className="smallcaps"
                  style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 8 }}
                >
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding: "64px 32px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <SectionHeader
            eyebrow="the mechanism"
            title="A clockwork in three movements."
            subtitle="ORLOJ behaves like Prague's astronomical clock — public, deterministic, and slightly theatrical."
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 24,
              marginTop: 36,
            }}
          >
            {[
              {
                n: "I",
                t: "Publish",
                d: "Submit a contract address. We resolve the ABI, hash the manifest, and pin it to IPFS.",
              },
              {
                n: "II",
                t: "Bind",
                d: "An operator picks an MCP, scopes a vault, and the agent receives a session‑signed credential.",
              },
              {
                n: "III",
                t: "Strike",
                d: "Each tool call is logged, rate‑limited, and revocable — like the bell at noon.",
              },
            ].map((m, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  padding: 28,
                  background: "rgba(241,233,212,0.5)",
                  border: "1px solid var(--line)",
                }}
              >
                <div
                  className="display"
                  style={{
                    fontSize: 56,
                    color: "var(--brass)",
                    lineHeight: 1,
                    opacity: 0.9,
                  }}
                >
                  {m.n}
                </div>
                <div
                  className="display"
                  style={{ fontSize: 22, color: "var(--ink)", marginTop: 8 }}
                >
                  {m.t}
                </div>
                <p
                  style={{
                    color: "var(--ink-soft)",
                    marginTop: 8,
                    marginBottom: 0,
                    lineHeight: 1.55,
                    fontSize: 14,
                  }}
                >
                  {m.d}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

    </main>
  );
};

const ClockTableau = () => (
  <div
    style={{ position: "relative", width: "100%", maxWidth: 480, height: 520 }}
  >
    <div
      style={{ position: "absolute", inset: 0, color: "var(--brass)" }}
    >
      <ArtNouveauArch style={{ width: "100%", height: "100%" }} />
    </div>
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: 30,
        transform: "translateX(-50%)",
        width: 280,
        height: 380,
        border: "3px solid var(--brass)",
        boxShadow: "6px 6px 0 var(--ink)",
        clipPath:
          'path("M140,0 Q280,0 280,140 L280,380 L0,380 L0,140 Q0,0 140,0 Z")',
      }}
    >
      <StainedPanel seed={3} />
    </div>
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: 220,
        transform: "translateX(-50%)",
        width: 200,
        height: 200,
        background: "radial-gradient(circle, var(--ink) 0%, var(--ink-2) 100%)",
        borderRadius: "50%",
        border: "4px solid var(--brass)",
        boxShadow:
          "0 16px 40px rgba(0,0,0,0.25), inset 0 0 0 8px var(--ink-2)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <OrlojMark size={160} />
    </div>
    <div
      style={{
        position: "absolute",
        left: -20,
        top: 100,
        color: "var(--brass-deep)",
      }}
    >
      <GearIcon size={64} spinning />
    </div>
    <div
      style={{
        position: "absolute",
        right: -10,
        top: 380,
        color: "var(--verdigris)",
      }}
    >
      <GearIcon size={48} spinning />
    </div>
    <div
      style={{
        position: "absolute",
        right: 20,
        top: 60,
        color: "var(--wine)",
      }}
    >
      <GearIcon size={36} spinning />
    </div>
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        textAlign: "center",
      }}
    >
      <div
        className="smallcaps"
        style={{ fontSize: 11, color: "var(--ink-soft)" }}
      >
        · orloj v0.4 · staré město ·
      </div>
    </div>
  </div>
);

const ForkCard = ({
  tone,
  kicker,
  title,
  body,
  bullets,
  cta,
  onClick,
  illustration,
}: {
  tone: string;
  kicker: string;
  title: string;
  body: string;
  bullets: string[];
  cta: string;
  onClick: () => void;
  illustration: React.ReactNode;
}) => {
  const dark = tone === "verdigris";
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        padding: 32,
        background: dark ? "var(--verdigris-deep)" : "var(--parchment-2)",
        color: dark ? "var(--parchment)" : "var(--ink)",
        border: `1px solid ${dark ? "var(--verdigris-deep)" : "var(--line)"}`,
        cursor: "pointer",
        transition: "transform 0.2s ease, box-shadow 0.2s ease",
        boxShadow: "4px 4px 0 var(--brass)",
        overflow: "hidden",
        minHeight: 520,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translate(-3px,-3px)";
        e.currentTarget.style.boxShadow = "8px 8px 0 var(--brass)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = "4px 4px 0 var(--brass)";
      }}
    >
      <div
        style={{ position: "absolute", top: 12, right: 12, opacity: 0.18 }}
      >
        {illustration}
      </div>
      <div
        className="smallcaps"
        style={{
          fontSize: 11,
          color: dark ? "var(--brass-bright)" : "var(--brass-deep)",
        }}
      >
        {kicker}
      </div>
      <h3
        className="display"
        style={{
          fontSize: "clamp(28px, 3.4vw, 38px)",
          margin: "14px 0 0",
          lineHeight: 1.05,
        }}
      >
        {title}
      </h3>
      <p
        style={{
          color: dark ? "rgba(241,233,212,0.8)" : "var(--ink-soft)",
          marginTop: 16,
          lineHeight: 1.55,
          maxWidth: 460,
        }}
      >
        {body}
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "24px 0",
          display: "grid",
          gap: 8,
        }}
      >
        {bullets.map((b) => (
          <li
            key={b}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "baseline",
              fontSize: 13.5,
            }}
          >
            <span
              style={{
                color: dark ? "var(--brass-bright)" : "var(--brass)",
              }}
            >
              ✦
            </span>{" "}
            {b}
          </li>
        ))}
      </ul>
      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: 32,
          right: 32,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          className="display"
          style={{ fontSize: 16, letterSpacing: "0.16em" }}
        >
          {cta} →
        </span>
        <div
          style={{
            width: 40,
            height: 40,
            border: `1.5px solid ${dark ? "var(--brass-bright)" : "var(--brass)"}`,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
          }}
        >
          <span
            style={{
              color: dark ? "var(--brass-bright)" : "var(--brass-deep)",
            }}
          >
            ↗
          </span>
        </div>
      </div>
    </div>
  );
};

const RegisterIllustration = () => (
  <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      style={{ color: "var(--ink)" }}
    >
      <rect x="40" y="40" width="120" height="120" />
      <rect x="50" y="50" width="100" height="100" />
      <path d="M40,100 H160 M100,40 V160" />
      <circle cx="100" cy="100" r="20" />
      <path d="M100,80 V60 M100,140 V120 M80,100 H60 M140,100 H120" />
    </g>
  </svg>
);

const ExploreIllustration = () => (
  <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      style={{ color: "var(--parchment)" }}
    >
      <circle cx="80" cy="80" r="50" />
      <circle cx="80" cy="80" r="30" />
      <line x1="120" y1="120" x2="170" y2="170" />
      <path d="M80,30 V130 M30,80 H130" opacity="0.5" />
    </g>
  </svg>
);
