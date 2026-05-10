"use client";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { StainedPanel, Pill, Btn, Input } from "./ornaments";
import { authClient } from "@/lib/auth-client";
import { SHORT_ADDR, SHORT_NAME, type Mcp } from "./data";
import { LaunchModal, type RegisterResult } from "./launch-modal";
import { useT, useLocale } from "./i18n-context";
import type { Locale } from "@/app/[lang]/dictionaries";

const LOCALE_OPTIONS: { code: Locale; badge: string; name: string }[] = [
  { code: "en", badge: "EN", name: "English" },
  { code: "cs", badge: "CS", name: "Čeština" },
  { code: "de", badge: "DE", name: "Deutsch" },
  { code: "fr", badge: "FR", name: "Français" },
  { code: "es", badge: "ES", name: "Español" },
  { code: "zh", badge: "中文", name: "中文" },
];

const LanguageSwitcher = () => {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const current = LOCALE_OPTIONS.find((o) => o.code === locale) ?? LOCALE_OPTIONS[0];

  const switchTo = (code: Locale) => {
    setOpen(false);
    if (code === locale) return;
    const segments = pathname.split("/"); // ["", "en", ...]
    const rest = segments.slice(2).join("/");
    router.push(`/${code}${rest ? `/${rest}` : ""}`);
  };

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="smallcaps"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "6px 10px",
          background: "transparent",
          border: "1px solid var(--line)",
          cursor: "pointer",
          fontFamily: "var(--font-ui)",
          fontSize: 11,
          letterSpacing: "0.16em",
          color: "var(--ink)",
          transition: "border-color 0.15s",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--brass)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.borderColor = "var(--line)";
        }}
      >
        {current.badge}
        <span style={{ opacity: 0.5, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            paddingTop: 4,
            zIndex: 50,
            minWidth: 140,
          }}
        >
        <div
          style={{
            background: "var(--parchment)",
            border: "1px solid var(--line)",
            boxShadow: "4px 4px 0 var(--brass)",
          }}
        >
          {LOCALE_OPTIONS.map((opt, i) => {
            const active = opt.code === locale;
            return (
              <button
                key={opt.code}
                onClick={() => switchTo(opt.code)}
                className="smallcaps"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "9px 14px",
                  background: active ? "rgba(184,137,58,0.10)" : "transparent",
                  border: "none",
                  borderBottom:
                    i < LOCALE_OPTIONS.length - 1
                      ? "1px solid rgba(0,0,0,0.05)"
                      : "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                  fontSize: 11,
                  color: active ? "var(--brass-deep)" : "var(--ink)",
                  letterSpacing: "0.14em",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(184,137,58,0.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = active
                    ? "rgba(184,137,58,0.10)"
                    : "transparent";
                }}
              >
                <span
                  style={{
                    width: 22,
                    fontWeight: 700,
                    flexShrink: 0,
                    color: active ? "var(--brass-deep)" : "var(--ink-soft)",
                  }}
                >
                  {opt.badge}
                </span>
                <span style={{ opacity: active ? 1 : 0.7 }}>{opt.name}</span>
                {active && (
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "var(--brass)",
                      fontSize: 9,
                    }}
                  >
                    ✦
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </div>
      )}
    </div>
  );
};

export const LoginModal = ({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (provider: string) => void;
}) => {
  const t = useT();
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
        className="login-modal"
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
          className="login-modal-left"
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
              {t("auth.quote")}
            </div>
            <div
              className="smallcaps"
              style={{
                marginTop: 16,
                fontSize: 11,
                color: "var(--brass-bright)",
              }}
            >
              {t("auth.quoteSource")}
            </div>
          </div>
        </div>

        {/* right: form */}
        <div className="login-modal-right" style={{ padding: "24px 28px", position: "relative" }}>
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

          <Pill tone="brass">{t("auth.signInPill")}</Pill>
          <h2
            className="display"
            style={{ fontSize: 22, marginTop: 8, marginBottom: 2 }}
          >
            {t("auth.welcomeBack")}
          </h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: 4 }}>
            {t("auth.oneIdentity")}
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
                ✦ {t("auth.checkInbox")}
              </div>
              <div
                className="display"
                style={{ fontSize: 18, color: "var(--ink)" }}
              >
                {t("auth.signalOnItsWay")}
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                {t("auth.sentLinkTo", { email: sentTo })}
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
                {t("auth.useDifferentEmail")}
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
                  ? t("auth.sending")
                  : t("auth.emailMeLink")}
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
              {t("auth.or")}
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
                {t("auth.continueWith", { provider: p.label })}
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
  const t = useT();
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
          {(/^0x[a-fA-F0-9]{40}$/.test(user.name) ? user.name.slice(2, 4) : user.name)
            .split(" ")
            .map((s: string) => s[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <span
          style={{
            fontSize: 13,
            maxWidth: 120,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={user.name}
        >
          {SHORT_NAME(user.name, 12)}
        </span>
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
              {t("nav.signOut")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const NavSearch = () => {
  const t = useT();
  const locale = useLocale();
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [mcps, setMcps] = useState<Mcp[]>([]);
  const [launchMcp, setLaunchMcp] = useState<RegisterResult | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/mcps")
      .then((res) => (res.ok ? res.json() : { mcps: [] }))
      .then((data: { mcps?: Mcp[] }) => {
        if (!cancelled && Array.isArray(data.mcps)) setMcps(data.mcps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = q.trim();
  const results = trimmed
    ? mcps
        .filter((m) =>
          `${m.name} ${m.author} ${m.tags.join(" ")}`
            .toLowerCase()
            .includes(trimmed.toLowerCase()),
        )
        .slice(0, 6)
    : [];

  const open = focused && trimmed.length > 0;

  const go = () => {
    router.push(`/${locale}/explore?q=${encodeURIComponent(trimmed || "")}`);
    setQ("");
    inputRef.current?.blur();
  };

  const openLaunchModal = (m: Mcp) => {
    setLaunchMcp({
      name: m.id,
      contractName: m.name,
      mcpUrl: m.mcpUrl,
      chainId: m.chainId,
      address: m.contract || false,
    });
    setQ("");
    inputRef.current?.blur();
  };

  return (
    <>
    <div className="nav-search" style={{ position: "relative" }}>
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
          placeholder={t("auth.searchPlaceholder")}
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
                onMouseDown={(e) => { e.preventDefault(); openLaunchModal(m); }}
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
                  <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 2 }}>
                    {m.author.startsWith("0x") ? SHORT_ADDR(m.author) : m.author}
                    {m.tags[0] ? ` · ${m.tags[0]}` : ""}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", flexShrink: 0 }}>
                  {m.chain}
                </span>
              </button>
            ))
          ) : (
            <div style={{ padding: "14px 14px", fontSize: 13, color: "var(--ink-soft)" }}>
              {t("auth.noInterfacesFound")}
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
            <span>{t("auth.seeAllResultsFor")} &ldquo;{trimmed}&rdquo;</span>
            <span>→</span>
          </button>
        </div>
      )}
    </div>
    {launchMcp &&
      createPortal(
        <LaunchModal result={launchMcp} onCloseAction={() => setLaunchMcp(null)} />,
        document.body,
      )}
    </>
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
  const t = useT();
  const items = [
    { id: "explore", l: t("nav.explore") },
    { id: "register", l: t("nav.register") },
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
        className="nav-wrap"
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
          className="nav-brand"
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
              className="display nav-brand-text"
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
        <nav className="nav-items" style={{ display: "flex", gap: 4, marginLeft: 24 }}>
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
        <LanguageSwitcher />
        {user ? (
          <UserMenu
            user={user}
            route={route}
            onNavigate={onNavigate}
            onLogout={onLogout}
          />
        ) : (
          <Btn kind="primary" size="sm" onClick={onLogin}>
            {t("nav.signIn")}
          </Btn>
        )}
      </div>
    </header>
  );
};
