"use client";
import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { StainedPanel, Pill, Btn } from "./ornaments";
import { MCP_REGISTRY } from "./data";

export const LoginModal = ({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (provider: string) => void;
}) => {
  const providers = [
    { id: "wallet", label: "Ethereum wallet (SIWE)", icon: "◆" },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,22,18,0.55)",
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 100%)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          background: "var(--parchment)",
          border: "1px solid var(--ink)",
          boxShadow: "8px 8px 0 var(--brass)",
          overflow: "hidden",
        }}
      >
        {/* left: stained glass */}
        <div
          style={{
            position: "relative",
            background: "var(--verdigris-deep)",
            minHeight: 0,
            color: "var(--parchment)",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ position: "absolute", inset: 0, opacity: 0.4 }}>
            <StainedPanel seed={11} width={440} height={320} />
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Image src="/logo.png" alt="Orloj" width={36} height={36} />
              <div
                className="display"
                style={{ fontSize: 22, letterSpacing: "0.18em" }}
              >
                ORLOJ
              </div>
            </div>
          </div>
          <div style={{ position: "relative", paddingTop: 32 }}>
            <div className="poetic" style={{ fontSize: 30, lineHeight: 1.2 }}>
              "When the noon bell strikes, the apostles parade — and your agent
              signs."
            </div>
            <div
              className="smallcaps"
              style={{
                marginTop: 16,
                fontSize: 11,
                color: "var(--brass-bright)",
              }}
            >
              — a guide to the orloj, 2026 ed.
            </div>
          </div>
        </div>

        {/* right: form */}
        <div style={{ padding: "24px 28px", position: "relative" }}>
          <button
            onClick={onClose}
            style={{
              position: "absolute",
              top: 14,
              right: 14,
              width: 32,
              height: 32,
              border: "1px solid var(--line)",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              color: "var(--ink)",
            }}
          >
            ×
          </button>

          <Pill tone="brass">sign in</Pill>
          <h2
            className="display"
            style={{ fontSize: 22, marginTop: 8, marginBottom: 2 }}
          >
            Welcome back to the square.
          </h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: 4 }}>
            One identity, all your agents.
          </p>

          <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => onLogin(p.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  background: "transparent",
                  border: "1px solid var(--line)",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                  fontSize: 14,
                  color: "var(--ink)",
                  transition: "background 0.18s, border 0.18s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(184,137,58,0.1)";
                  e.currentTarget.style.borderColor = "var(--brass)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderColor = "var(--line)";
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    display: "grid",
                    placeItems: "center",
                    background: "var(--parchment-3)",
                    color: "var(--ink)",
                    fontSize: 14,
                  }}
                >
                  {p.icon}
                </span>
                Continue with {p.label}
                <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
                  →
                </span>
              </button>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
};

const UserMenu = ({
  user,
  route,
  onNavigate,
  onLogout,
}: {
  user: { name: string };
  route: string;
  onNavigate: (r: string) => void;
  onLogout: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const onProfile = route === "profile";

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => { setOpen(false); onNavigate("profile"); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px 6px 6px",
          background: onProfile ? "var(--ink)" : "transparent",
          color: onProfile ? "var(--parchment)" : "var(--ink)",
          border: "1px solid var(--line)",
          cursor: "pointer",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            background: "var(--brass)",
            display: "grid",
            placeItems: "center",
            color: "var(--ink)",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {user.name
            .split(" ")
            .map((s: string) => s[0])
            .join("")
            .slice(0, 2)}
        </div>
        <span style={{ fontSize: 13 }}>{user.name.split(" ")[0]}</span>
        <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            paddingTop: 4,
            minWidth: 160,
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: "var(--parchment)",
              border: "1px solid var(--line)",
              boxShadow: "4px 4px 0 var(--brass)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <button
              onClick={() => { setOpen(false); onLogout(); }}
              style={{
                padding: "11px 16px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                fontSize: 13,
                color: "var(--wine, #8c1e28)",
                textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(140,30,40,0.08)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const NavSearch = () => {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const trimmed = q.trim();
  const results = trimmed
    ? MCP_REGISTRY.filter((m) =>
        `${m.name} ${m.author} ${m.tags.join(" ")}`
          .toLowerCase()
          .includes(trimmed.toLowerCase())
      ).slice(0, 6)
    : [];

  const open = focused && trimmed.length > 0;

  const go = () => {
    router.push(`/explore?q=${encodeURIComponent(trimmed || "")}`);
    setQ("");
    inputRef.current?.blur();
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: `1px solid ${focused ? "var(--brass)" : "var(--line)"}`,
          background: "transparent",
          transition: "border-color 0.15s",
          width: focused ? 260 : 190,
        }}
      >
        <span style={{ color: "var(--ink-soft)", fontSize: 14, flexShrink: 0 }}>⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setQ(""); inputRef.current?.blur(); }
            else if (e.key === "Enter") { go(); }
          }}
          placeholder="search the registry"
          className="mono"
          style={{
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: 12,
            color: "var(--ink)",
            width: "100%",
            minWidth: 0,
          }}
        />
        {!focused && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 4px",
              background: "var(--parchment-3)",
              color: "var(--ink-soft)",
              flexShrink: 0,
              pointerEvents: "none",
            }}
          >
            ⌘K
          </span>
        )}
      </div>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: 340,
            background: "var(--parchment)",
            border: "1px solid var(--line)",
            boxShadow: "4px 4px 0 var(--brass)",
            zIndex: 50,
          }}
        >
          {results.length > 0 ? (
            results.map((m) => (
              <button
                key={m.id}
                onMouseDown={go}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "10px 14px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(0,0,0,0.06)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "var(--font-ui)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(184,137,58,0.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>
                    {m.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 2 }}>
                    {m.author} · {m.tags[0]}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", flexShrink: 0 }}>
                  {m.chain}
                </span>
              </button>
            ))
          ) : (
            <div style={{ padding: "14px 14px", fontSize: 13, color: "var(--ink-soft)" }}>
              No interfaces found
            </div>
          )}
          <button
            onMouseDown={go}
            className="smallcaps"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "10px 14px",
              background: "rgba(241,233,212,0.7)",
              border: "none",
              borderTop: "1px solid var(--line)",
              cursor: "pointer",
              fontSize: 11,
              color: "var(--ink-soft)",
              fontFamily: "var(--font-ui)",
              letterSpacing: "0.14em",
            }}
          >
            <span>See all results for &ldquo;{trimmed}&rdquo;</span>
            <span>→</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const TopNav = ({
  route,
  onNavigate,
  user,
  onLogin,
  onLogout,
}: {
  route: string;
  onNavigate: (r: string) => void;
  user: { name: string } | null;
  onLogin: () => void;
  onLogout: () => void;
}) => {
  const items = [
    { id: "explore", l: "Explore" },
    { id: "register", l: "Register" },
  ];
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: "rgba(241,233,212,0.92)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "14px 32px",
          display: "flex",
          alignItems: "center",
          gap: 24,
        }}
      >
        <button
          onClick={() => onNavigate("home")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          <Image src="/logo.png" alt="Orloj" width={36} height={36} />
          <div>
            <div
              className="display"
              style={{
                fontSize: 18,
                lineHeight: 1,
                color: "var(--ink)",
                letterSpacing: "0.22em",
              }}
            >
              ORLOJ
            </div>
          </div>
        </button>
        <nav style={{ display: "flex", gap: 4, marginLeft: 24 }}>
          {items.map((i) => {
            const active = route === i.id;
            return (
              <button
                key={i.id}
                onClick={() => onNavigate(i.id)}
                className="smallcaps"
                style={{
                  padding: "8px 14px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "var(--font-ui)",
                  color: active ? "var(--ink)" : "var(--ink-soft)",
                  position: "relative",
                }}
              >
                {i.l}
                {active && (
                  <span
                    style={{
                      position: "absolute",
                      bottom: 2,
                      left: 14,
                      right: 14,
                      height: 2,
                      background: "var(--brass)",
                    }}
                  />
                )}
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        <NavSearch />
        {user ? (
          <UserMenu
            user={user}
            route={route}
            onNavigate={onNavigate}
            onLogout={onLogout}
          />
        ) : (
          <Btn kind="primary" size="sm" onClick={onLogin}>
            Sign in
          </Btn>
        )}
      </div>
    </header>
  );
};
