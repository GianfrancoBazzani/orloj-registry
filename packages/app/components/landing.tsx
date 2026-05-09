"use client";
import { useRouter } from "next/navigation";
import { Pill, Btn, Divider, SectionHeader } from "./ornaments";

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
            gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
            gap: "clamp(48px, 8vw, 112px)",
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
              <Pill tone="verdigris">✦ ethprague · hackathon</Pill>
            </div>
            <h1
              className="display"
              style={{
                fontSize: "clamp(38px, 5vw, 68px)",
                lineHeight: 1.02,
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
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <ClockTableau />
            <div
              className="smallcaps"
              style={{
                fontSize: 10,
                letterSpacing: "0.28em",
                color: "var(--ink-soft)",
                marginTop: 12,
                textAlign: "center",
              }}
            >
              · orloj · staré město ·
            </div>
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

const ClockTableau = () => {
  const cx = 240, cy = 260;

  // Crescent path: fat part faces LEFT (−x). Rotate to orient.
  // Outer circle r=14 at origin; inner circle r=12 centered at (5,0).
  // Intersection at x≈7.7, y≈±11.7.
  const CP = "M 7.7,-11.7 A 14 14 0 1 0 7.7,11.7 A 12 12 0 0 0 7.7,-11.7 Z";
  // Small crescent (ring C): r=8, inner r=6, offset d=3 → x≈6.2, y≈±5.1
  const SCP = "M 6.2,-5.1 A 8 8 0 1 0 6.2,5.1 A 6 6 0 0 0 6.2,-5.1 Z";

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 480, height: 520 }}>
      <svg viewBox="0 0 480 520" width="100%" height="100%" aria-hidden="true">
        <defs>
          <style>{`
            @keyframes og-cw  { to { transform: rotate(360deg);  } }
            @keyframes og-ccw { to { transform: rotate(-360deg); } }
            .og-ra { transform-origin: 240px 260px; animation: og-cw  120s linear infinite; }
            .og-rb { transform-origin: 240px 260px; animation: og-ccw  70s linear infinite; }
            .og-rc { transform-origin: 240px 260px; animation: og-cw   40s linear infinite; }
            .og-rh { transform-origin: 240px 260px; animation: og-cw   20s linear infinite; }
          `}</style>

          <radialGradient id="og-gold" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#F7EBB0"/>
            <stop offset="40%"  stopColor="#C8913A"/>
            <stop offset="100%" stopColor="#6A4818"/>
          </radialGradient>
          <radialGradient id="og-dark" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#252018"/>
            <stop offset="100%" stopColor="#0D0B09"/>
          </radialGradient>

          <filter id="og-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect width="480" height="520" fill="#0D0B09"/>

        {/* Art Deco chamfered frame */}
        <path d="M52,12 H428 L468,52 V468 L428,508 H52 L12,468 V52 Z"
          fill="none" stroke="#C8913A" strokeWidth="1.2" strokeOpacity="0.75"/>
        <path d="M60,20 H420 L460,60 V460 L420,500 H60 L20,460 V60 Z"
          fill="none" stroke="#C8913A" strokeWidth="0.4" strokeOpacity="0.3"/>

        {/* Corner brackets */}
        {([
          [12, 52, 1, 1], [468, 52, -1, 1],
          [12, 468, 1, -1], [468, 468, -1, -1],
        ] as [number,number,number,number][]).map(([x,y,dx,dy], i) => (
          <g key={i} stroke="#C8913A" strokeWidth="1" fill="none" strokeOpacity="0.85">
            <line x1={x} y1={y} x2={x + dx*40} y2={y}/>
            <line x1={x} y1={y} x2={x}         y2={y + dy*40}/>
            <circle cx={x + dx*40} cy={y + dy*40} r="3" fill="#C8913A" stroke="none"/>
          </g>
        ))}

        {/* Ambient halos */}
        <circle cx={cx} cy={cy} r="195" fill="#C8913A" fillOpacity="0.025"/>
        <circle cx={cx} cy={cy} r="130" fill="#C8913A" fillOpacity="0.04"/>
        <circle cx={cx} cy={cy} r="70"  fill="#C8913A" fillOpacity="0.055"/>

        {/* ── RING A: outermost, CW 120s ── */}
        <g className="og-ra">
          <circle cx={cx} cy={cy} r="198" fill="none" stroke="#C8913A" strokeWidth="0.7" strokeOpacity="0.6"/>
          <circle cx={cx} cy={cy} r="185" fill="none" stroke="#C8913A" strokeWidth="0.7" strokeOpacity="0.6"/>
          {Array.from({ length: 24 }, (_, i) => {
            const a = (i/24)*Math.PI*2 - Math.PI/2;
            const cos = Math.cos(a), sin = Math.sin(a);
            const major = i%6===0, mid = i%3===0;
            const r2 = major ? 167 : mid ? 176 : 181;
            return (
              <line key={i}
                x1={cx + cos*185} y1={cy + sin*185}
                x2={cx + cos*r2}  y2={cy + sin*r2}
                stroke="#C8913A"
                strokeWidth={major ? 2 : mid ? 1.2 : 0.6}
                strokeOpacity={major ? 1 : mid ? 0.8 : 0.5}
              />
            );
          })}
          {/* Cardinal diamond markers */}
          {Array.from({ length: 4 }, (_, i) => {
            const a = (i/4)*Math.PI*2 - Math.PI/2;
            return (
              <g key={i} transform={`translate(${cx + Math.cos(a)*198},${cy + Math.sin(a)*198}) rotate(${i*90})`}>
                <polygon points="0,-7 6,0 0,7 -6,0" fill="#F7EBB0"/>
              </g>
            );
          })}
          {/* 12 o'clock crescent — fat faces up (rotate 90°) */}
          <g transform={`translate(${cx},${cy-190}) rotate(90)`}>
            <path d={CP} fill="#C8913A" fillOpacity="0.55"/>
          </g>
          {/* 6 o'clock crescent — fat faces down (rotate −90°) */}
          <g transform={`translate(${cx},${cy+190}) rotate(-90)`}>
            <path d={CP} fill="#C8913A" fillOpacity="0.55"/>
          </g>
        </g>

        {/* ── RING B: middle, CCW 70s ── */}
        <g className="og-rb">
          <circle cx={cx} cy={cy} r="152" fill="none" stroke="#C8913A" strokeWidth="1.5" strokeOpacity="0.9"/>
          <circle cx={cx} cy={cy} r="142" fill="none" stroke="#C8913A" strokeWidth="0.5" strokeOpacity="0.35"/>
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i/12)*Math.PI*2 - Math.PI/2;
            const cos = Math.cos(a), sin = Math.sin(a);
            const major = i%3===0;
            return (
              <g key={i}>
                <line
                  x1={cx + cos*142} y1={cy + sin*142}
                  x2={cx + cos*(major ? 120 : 131)} y2={cy + sin*(major ? 120 : 131)}
                  stroke="#C8913A" strokeWidth={major ? 2 : 1} strokeOpacity="0.9"
                />
                {major && <>
                  <circle cx={cx + cos*158} cy={cy + sin*158}
                    r="6.5" fill="none" stroke="#F7EBB0" strokeWidth="1" strokeOpacity="0.8"/>
                  <circle cx={cx + cos*158} cy={cy + sin*158} r="2.5" fill="#F7EBB0"/>
                </>}
              </g>
            );
          })}
          {/* Dashed elliptical orbit */}
          <ellipse cx={cx} cy={cy} rx="135" ry="70"
            fill="none" stroke="#C8913A" strokeWidth="0.8" strokeOpacity="0.35" strokeDasharray="3 5"/>
          {/* Orbital body at top of ellipse */}
          <g filter="url(#og-glow)">
            <circle cx={cx} cy={cy-70} r="7"  fill="url(#og-gold)"/>
            <circle cx={cx} cy={cy-70} r="11" fill="none" stroke="#F7EBB0" strokeWidth="0.8" strokeOpacity="0.55"/>
          </g>
          {/* 3 o'clock crescent — fat faces right (rotate 180°) */}
          <g transform={`translate(${cx+152},${cy}) rotate(180)`}>
            <path d={CP} fill="#C8913A" fillOpacity="0.5"/>
          </g>
          {/* 9 o'clock crescent — fat faces left (rotate 0°) */}
          <g transform={`translate(${cx-152},${cy}) rotate(0)`}>
            <path d={CP} fill="#C8913A" fillOpacity="0.5"/>
          </g>
        </g>

        {/* ── RING C: inner, CW 40s ── */}
        <g className="og-rc">
          <circle cx={cx} cy={cy} r="100" fill="none" stroke="#C8913A" strokeWidth="2.2" strokeOpacity="0.95"
            filter="url(#og-glow)"/>
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i/8)*Math.PI*2 - Math.PI/2;
            const cos = Math.cos(a), sin = Math.sin(a);
            const major = i%2===0;
            return (
              <line key={i}
                x1={cx + cos*100} y1={cy + sin*100}
                x2={cx + cos*(major ? 81 : 89)} y2={cy + sin*(major ? 81 : 89)}
                stroke={major ? "#F7EBB0" : "#C8913A"}
                strokeWidth={major ? 2.2 : 1.2} strokeOpacity="1"
              />
            );
          })}
          {/* Small crescents at intercardinals, fat facing outward */}
          {[45, 135, 225, 315].map((deg, i) => {
            const a = (deg-90)*Math.PI/180;
            return (
              <g key={i} transform={`translate(${cx + Math.cos(a)*100},${cy + Math.sin(a)*100}) rotate(${deg+90})`}>
                <path d={SCP} fill="#C8913A" fillOpacity="0.65"/>
              </g>
            );
          })}
        </g>

        {/* ── COMPASS HAND: CW 20s ── */}
        <g className="og-rh">
          {[0, 90, 180, 270].map((deg, i) => {
            const a = (deg-90)*Math.PI/180;
            const cos = Math.cos(a), sin = Math.sin(a);
            const perp = a + Math.PI/2;
            const pc = Math.cos(perp), ps = Math.sin(perp);
            return (
              <g key={i}>
                <line x1={cx} y1={cy} x2={cx + cos*85} y2={cy + sin*85}
                  stroke="#C8913A" strokeWidth="1.5" strokeOpacity="0.85"/>
                <polygon points={[
                  `${cx + cos*85},${cy + sin*85}`,
                  `${cx + cos*68 + pc*6.5},${cy + sin*68 + ps*6.5}`,
                  `${cx + cos*68 - pc*6.5},${cy + sin*68 - ps*6.5}`,
                ].join(" ")} fill="#F7EBB0" fillOpacity="0.9"/>
              </g>
            );
          })}
          {[45, 135, 225, 315].map((deg, i) => {
            const a = (deg-90)*Math.PI/180;
            return (
              <line key={i}
                x1={cx + Math.cos(a)*12} y1={cy + Math.sin(a)*12}
                x2={cx + Math.cos(a)*62} y2={cy + Math.sin(a)*62}
                stroke="#C8913A" strokeWidth="0.9" strokeOpacity="0.6"
              />
            );
          })}
        </g>

        {/* ── CENTRAL DISC (static) ── */}
        <circle cx={cx} cy={cy} r="35" fill="url(#og-dark)"/>
        <circle cx={cx} cy={cy} r="35" fill="none" stroke="#F7EBB0" strokeWidth="1.5"/>
        <circle cx={cx} cy={cy} r="28" fill="none" stroke="#C8913A" strokeWidth="0.7" strokeOpacity="0.45"/>
        {/* Main compass petals */}
        {[0, 90, 180, 270].map((deg, i) => {
          const a = (deg-90)*Math.PI/180;
          const cos = Math.cos(a), sin = Math.sin(a);
          const perp = a + Math.PI/2;
          const pc = Math.cos(perp), ps = Math.sin(perp);
          return (
            <polygon key={i} points={[
              `${cx + cos*30},${cy + sin*30}`,
              `${cx + cos*18 + pc*7},${cy + sin*18 + ps*7}`,
              `${cx},${cy}`,
              `${cx + cos*18 - pc*7},${cy + sin*18 - ps*7}`,
            ].join(" ")} fill="#C8913A" fillOpacity="0.95" filter="url(#og-glow)"/>
          );
        })}
        {/* Secondary compass petals */}
        {[45, 135, 225, 315].map((deg, i) => {
          const a = (deg-90)*Math.PI/180;
          const cos = Math.cos(a), sin = Math.sin(a);
          const perp = a + Math.PI/2;
          const pc = Math.cos(perp), ps = Math.sin(perp);
          return (
            <polygon key={i} points={[
              `${cx + cos*22},${cy + sin*22}`,
              `${cx + cos*12 + pc*5},${cy + sin*12 + ps*5}`,
              `${cx},${cy}`,
              `${cx + cos*12 - pc*5},${cy + sin*12 - ps*5}`,
            ].join(" ")} fill="#F7EBB0" fillOpacity="0.72"/>
          );
        })}
        <circle cx={cx} cy={cy} r="6.5" fill="#F7EBB0"/>
        <circle cx={cx} cy={cy} r="3"   fill="#0D0B09"/>

        {/* ── ART DECO TOP ORNAMENT ── */}
        <g stroke="#C8913A" fill="none" strokeOpacity="0.7">
          <path d={`M 172,22 Q ${cx},54 308,22`} strokeWidth="1"/>
          <line x1="210" y1="22" x2="210" y2="48" strokeWidth="0.8"/>
          <line x1={cx}  y1="22" x2={cx}  y2="54" strokeWidth="0.8"/>
          <line x1="270" y1="22" x2="270" y2="48" strokeWidth="0.8"/>
        </g>
        <circle cx={cx}  cy="22" r="5"   fill="#C8913A"/>
        <circle cx="210" cy="22" r="2.5" fill="#C8913A"/>
        <circle cx="270" cy="22" r="2.5" fill="#C8913A"/>

      </svg>
    </div>
  );
};

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
