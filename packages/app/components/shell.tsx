"use client";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./auth-context";
import { TopNav, LoginModal } from "./auth";
import { OrlojMark } from "./ornaments";
import Link from "next/link";

const ROUTE_MAP: Record<string, string> = {
  "/": "home",
  "/explore": "explore",
  "/register": "register",
  "/profile": "profile",
};

export const Shell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signIn, signOut, showLogin, setShowLogin } = useAuth();

  const route = ROUTE_MAP[pathname] ?? "home";

  const navigate = (r: string) => {
    if ((r === "profile" || r === "register") && !user) {
      setShowLogin(true);
      return;
    }
    router.push(r === "home" ? "/" : `/${r}`);
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

const Footer = () => (
  <footer
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
        display: "grid",
        gridTemplateColumns: "1.5fr 1fr 1fr 1fr",
        gap: 32,
        alignItems: "flex-start",
      }}
    >
      <div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <OrlojMark size={42} />
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
          The astronomical registry for smart interfaces. An
          OpenZeppelin-stewarded public good, presented at ETHPrague 2026.
        </p>
      </div>
      <FooterCol
        title="product"
        items={[
          ["Explore", "/explore"],
          ["Register", "/register"],
          ["Profile", "/profile"],
          ["Docs", "/docs"],
        ]}
      />
      <FooterCol
        title="builders"
        items={[
          ["Manifest spec", "/docs"],
          ["CLI", "/docs"],
          ["SDKs", "/docs"],
          ["Audits", "/docs"],
        ]}
      />
      <FooterCol
        title="society"
        items={[
          ["Open RFCs", "/docs"],
          ["Code of conduct", "/docs"],
          ["Contact", "/docs"],
        ]}
      />
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
      <div>© 2026 ORLOJ Foundation · z.ú., Praha</div>
      <div className="mono">
        manifest_v0.4 · indexer 81f2a · hello@orloj.eth
      </div>
    </div>
  </footer>
);

const FooterCol = ({
  title,
  items,
}: {
  title: string;
  items: [string, string][];
}) => (
  <div>
    <div
      className="smallcaps"
      style={{ fontSize: 11, color: "var(--brass-bright)", marginBottom: 10 }}
    >
      {title}
    </div>
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 6,
      }}
    >
      {items.map(([l, href]) => (
        <li key={l}>
          <Link
            href={href}
            style={{
              color: "rgba(241,233,212,0.85)",
              fontFamily: "var(--font-ui)",
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            {l}
          </Link>
        </li>
      ))}
    </ul>
  </div>
);
