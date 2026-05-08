"use client";
import { useState } from "react";
import { OrlojMark, StainedPanel, Pill, Btn, Field, Input } from "./ornaments";

export const LoginModal = ({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (provider: string) => void;
}) => {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const providers = [
    { id: "github", label: "GitHub", icon: "⌥" },
    { id: "google", label: "Google", icon: "◯" },
    { id: "wallet", label: "Ethereum wallet (SIWE)", icon: "◆" },
    { id: "farcaster", label: "Farcaster", icon: "✦" },
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
            minHeight: 520,
            color: "var(--parchment)",
            padding: 32,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ position: "absolute", inset: 0, opacity: 0.4 }}>
            <StainedPanel seed={11} width={440} height={520} />
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <OrlojMark size={36} />
              <div
                className="display"
                style={{ fontSize: 22, letterSpacing: "0.18em" }}
              >
                ORLOJ
              </div>
            </div>
          </div>
          <div style={{ position: "relative" }}>
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
        <div style={{ padding: "32px 36px", position: "relative" }}>
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

          <Pill tone="brass">
            {mode === "login" ? "sign in" : "create account"}
          </Pill>
          <h2
            className="display"
            style={{ fontSize: 28, marginTop: 12, marginBottom: 4 }}
          >
            {mode === "login"
              ? "Welcome back to the square."
              : "Take a seat in the square."}
          </h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: 4 }}>
            One identity, all your agents.
          </p>

          <div style={{ display: "grid", gap: 10, marginTop: 24 }}>
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

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: "24px 0",
            }}
          >
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span
              className="smallcaps"
              style={{ fontSize: 10, color: "var(--ink-soft)" }}
            >
              or
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <Field label="Email">
            <Input type="email" placeholder="you@studio.eth" />
          </Field>
          <div style={{ marginTop: 16 }}>
            <Btn
              kind="primary"
              style={{ width: "100%" }}
              onClick={() => onLogin("email")}
            >
              {mode === "login" ? "Sign in with magic link" : "Send signup link"}{" "}
              →
            </Btn>
          </div>

          <div
            style={{
              marginTop: 18,
              fontSize: 13,
              color: "var(--ink-soft)",
              textAlign: "center",
            }}
          >
            {mode === "login" ? "New to ORLOJ? " : "Already have an account? "}
            <button
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--brass-deep)",
                textDecoration: "underline",
                fontSize: 13,
                fontFamily: "var(--font-ui)",
              }}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
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
    { id: "docs", l: "Docs" },
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
          <OrlojMark size={36} />
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
            <div
              className="smallcaps"
              style={{ fontSize: 9, color: "var(--ink-soft)", marginTop: 2 }}
            >
              registry · v0.4
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
        <button
          onClick={() => onNavigate("explore")}
          className="mono"
          style={{
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid var(--line)",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--ink-soft)",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          ⌕ search the registry{" "}
          <span
            style={{
              fontSize: 10,
              padding: "2px 4px",
              background: "var(--parchment-3)",
            }}
          >
            ⌘K
          </span>
        </button>
        {user ? (
          <button
            onClick={() => onNavigate("profile")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 12px 6px 6px",
              background:
                route === "profile" ? "var(--ink)" : "transparent",
              color:
                route === "profile" ? "var(--parchment)" : "var(--ink)",
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
        ) : (
          <Btn kind="primary" size="sm" onClick={onLogin}>
            Sign in
          </Btn>
        )}
      </div>
    </header>
  );
};
