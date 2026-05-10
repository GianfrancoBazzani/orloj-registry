"use client";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./auth-context";
import { TopNav, LoginModal } from "./auth";
import { useLocale, useT } from "./i18n-context";
import Image from "next/image";

const ROUTE_KEYS: Record<string, string> = {
  "": "home",
  explore: "explore",
  register: "register",
  profile: "profile",
  docs: "docs",
};

export const Shell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const { user, signIn, signOut, showLogin, setShowLogin } = useAuth();

  // pathname is "/{locale}/{segment}" — segment is index 2
  const segment = pathname.split("/")[2] ?? "";
  const route = ROUTE_KEYS[segment] ?? "home";

  const navigate = (r: string) => {
    if ((r === "profile" || r === "register") && !user) {
      setShowLogin(true);
      return;
    }
    router.push(r === "home" ? `/${locale}` : `/${locale}/${r}`);
  };

  const handleLogin = async (provider: string) => {
    try {
      await signIn(provider as Parameters<typeof signIn>[0]);
      setShowLogin(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed";
      console.error("[auth] sign-in failed:", err);
      window.alert(message);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <TopNav
        route={route}
        onNavigate={navigate}
        user={user}
        onLogin={() => setShowLogin(true)}
        onLogout={() => {
          void signOut();
        }}
      />
      <div style={{ flex: 1 }}>{children}</div>
      <Footer />
      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onLogin={handleLogin}
        />
      )}
    </div>
  );
};

const Footer = () => {
  const t = useT();
  return (
    <footer
      className="site-footer"
      style={{
        marginTop: 60,
        padding: "40px 32px",
        background: "var(--ink)",
        color: "var(--parchment)",
        borderTop: "4px solid var(--brass)",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Image src="/logo.png" alt="Orloj" width={42} height={42} />
          <div>
            <div
              className="display"
              style={{ fontSize: 20, letterSpacing: "0.22em" }}
            >
              ORLOJ
            </div>
            <div
              className="smallcaps"
              style={{ fontSize: 9, color: "var(--brass-bright)", marginTop: 2 }}
            >
              since 2026 · staré město
            </div>
          </div>
        </div>
        <p
          className="poetic"
          style={{
            fontSize: 16,
            marginTop: 14,
            color: "rgba(241,233,212,0.7)",
            maxWidth: 360,
          }}
        >
          {t("shell.footerTagline")}
        </p>
      </div>
      <div
        style={{
          maxWidth: 1280,
          margin: "40px auto 0",
          borderTop: "1px solid rgba(241,233,212,0.18)",
          paddingTop: 20,
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          color: "rgba(241,233,212,0.5)",
          fontSize: 12,
        }}
      >
        <div>{t("shell.footerCopyright")}</div>
        <div className="mono">
          spacecomputer · sourcify
        </div>
      </div>
    </footer>
  );
};
