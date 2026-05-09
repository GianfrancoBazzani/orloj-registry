"use client";
import { useState } from "react";
import Image from "next/image";
import { OrlojMark, StainedPanel, Pill, Btn, Input } from "./ornaments";
import { authClient } from "@/lib/auth-client";

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

  const [email, setEmail] = useState("");
  const [magicStatus, setMagicStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [magicError, setMagicError] = useState("");
  const [sentTo, setSentTo] = useState("");

  const handleSendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setMagicStatus("sending");
    setMagicError("");
    const callbackURL =
      typeof window !== "undefined" ? window.location.pathname || "/" : "/";
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL,
    });
    if (error) {
      setMagicStatus("error");
      setMagicError(error.message ?? "Failed to send sign-in link");
      return;
    }
    setSentTo(email);
    setMagicStatus("sent");
  };

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
              &ldquo;When the noon bell strikes, the apostles parade — and
              your agent signs.&rdquo;
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

          <Pill tone="brass">sign in</Pill>
          <h2
            className="display"
            style={{ fontSize: 28, marginTop: 12, marginBottom: 4 }}
          >
            Welcome back to the square.
          </h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: 4 }}>
            One identity, all your agents.
          </p>

          {magicStatus === "sent" ? (
            <div
              style={{
                marginTop: 24,
                padding: "20px 18px",
                background: "rgba(47,110,94,0.08)",
                border: "1px solid rgba(47,110,94,0.35)",
                display: "grid",
                gap: 8,
              }}
            >
              <div
                className="smallcaps"
                style={{
                  fontSize: 11,
                  color: "var(--verdigris-deep)",
                }}
              >
                ✦ check your inbox
              </div>
              <div
                className="display"
                style={{ fontSize: 18, color: "var(--ink)" }}
              >
                A signal is on its way.
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                We sent a sign-in link to{" "}
                <span className="mono" style={{ color: "var(--ink)" }}>
                  {sentTo}
                </span>
                . The link expires in 5 minutes.
              </div>
              <button
                onClick={() => {
                  setMagicStatus("idle");
                  setEmail("");
                  setSentTo("");
                }}
                className="smallcaps"
                style={{
                  marginTop: 6,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  fontSize: 11,
                  color: "var(--brass-deep)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "var(--font-ui)",
                }}
              >
                use a different email →
              </button>
            </div>
          ) : (
            <form
              onSubmit={handleSendMagicLink}
              style={{ marginTop: 24, display: "grid", gap: 10 }}
            >
              <Input
                type="email"
                required
                placeholder="you@somewhere.eth"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={magicStatus === "sending"}
              />
              {magicStatus === "error" && (
                <div style={{ fontSize: 12, color: "var(--wine)" }}>
                  {magicError}
                </div>
              )}
              <Btn
                kind="primary"
                size="md"
                type="submit"
                disabled={magicStatus === "sending" || !email}
              >
                {magicStatus === "sending"
                  ? "sending…"
                  : "email me a sign-in link"}
              </Btn>
            </form>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "24px 0 16px",
            }}
          >
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span
              className="smallcaps"
              style={{
                fontSize: 10,
                color: "var(--ink-soft)",
                letterSpacing: "0.22em",
              }}
            >
              or
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <div style={{ display: "grid", gap: 10 }}>
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
