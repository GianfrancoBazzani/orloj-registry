"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-context";
import { useT } from "./i18n-context";
import { Btn, Tag } from "./ornaments";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface AgentAppMcp {
  id: string;
  name: string;
  summary: string;
  platform: string;
  tokens: string[];
  interactionType: string;
}

export function AgentAppSignIn() {
  const t = useT();
  const { setShowLogin } = useAuth();
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        <div className="display" style={{ fontSize: 32 }}>
          {t("agentApp.signInTitle")}
        </div>
        <p className="poetic" style={{ fontSize: 18, color: "var(--ink-soft)" }}>
          {t("agentApp.signInBody")}
        </p>
        <Btn kind="brass" onClick={() => setShowLogin(true)}>
          {t("agentApp.signIn")}
        </Btn>
      </div>
    </main>
  );
}

export function AgentApp({
  agentId,
  agentName,
  customAppName,
  hasCustomIcon,
  mcps,
}: {
  agentId: string;
  agentName: string;
  customAppName: string | null;
  hasCustomIcon: boolean;
  mcps: AgentAppMcp[];
}) {
  const t = useT();
  const iconInput = useRef<HTMLInputElement>(null);
  const [appName, setAppName] = useState(customAppName ?? "");
  const [icon, setIcon] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(display-mode: standalone)").matches,
  );

  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const saveBranding = async (clearIcon = false) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("appName", appName);
      if (icon) form.set("icon", icon);
      if (clearIcon) form.set("clearIcon", "true");
      const response = await fetch(`/api/agents/${agentId}/branding`, {
        method: "PUT",
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed (${response.status})`);
      }
      window.location.reload();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t("agentApp.saveFailed"),
      );
      setSaving(false);
    }
  };

  const install = async () => {
    if (!installPrompt) return;
    const result = await installPrompt.prompt();
    if (result.outcome === "accepted") setInstallPrompt(null);
  };

  return (
    <main style={{ minHeight: "100vh", background: "var(--parchment)", padding: "24px 18px 48px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            gap: 18,
            alignItems: "center",
            padding: 20,
            background: "var(--ink)",
            color: "var(--parchment)",
            borderBottom: "4px solid var(--brass)",
          }}
        >
          {/* The generated icon is the shared identity surface for the future chat. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/agents/${agentId}/icon/192`}
            alt=""
            width={72}
            height={72}
            style={{ borderRadius: 16, flex: "0 0 auto" }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="smallcaps" style={{ color: "var(--brass-bright)", fontSize: 10 }}>
              {t("agentApp.eyebrow")}
            </div>
            <h1 className="display" style={{ margin: "4px 0 0", fontSize: "clamp(24px, 5vw, 38px)" }}>
              {agentName}
            </h1>
            <div className="mono" style={{ marginTop: 5, fontSize: 10, opacity: 0.65 }}>
              {agentId}
            </div>
          </div>
          <Btn
            kind={installPrompt ? "brass" : "ghost"}
            disabled={!installPrompt || installed}
            onClick={install}
          >
            {installed ? t("agentApp.installed") : t("agentApp.install")}
          </Btn>
        </header>

        {!installed && !installPrompt && (
          <div style={{ padding: "10px 14px", border: "1px solid var(--line)", borderTop: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>
            {t("agentApp.installFallback")}
          </div>
        )}

        <section
          data-agent-chat-mount
          data-runtime-context-url={`/api/agents/${agentId}/context`}
          style={{
            marginTop: 20,
            padding: 24,
            minHeight: 180,
            border: "1px solid var(--line)",
            background: "rgba(255,255,255,0.32)",
          }}
        >
          <div className="smallcaps" style={{ fontSize: 10, color: "var(--brass-deep)" }}>
            {t("agentApp.chatMount")}
          </div>
          <h2 className="display" style={{ margin: "8px 0 0", fontSize: 24 }}>
            {t("agentApp.chatReady")}
          </h2>
          <p style={{ maxWidth: 620, color: "var(--ink-soft)", lineHeight: 1.55 }}>
            {t("agentApp.chatReadyBody")}
          </p>
          <code className="mono" style={{ fontSize: 11 }}>
            /api/agents/{agentId}/context
          </code>
        </section>

        <div className="agent-app-grid" style={{ display: "grid", gridTemplateColumns: "1.25fr 0.75fr", gap: 20, marginTop: 20 }}>
          <section style={{ padding: 20, border: "1px solid var(--line)" }}>
            <h2 className="display" style={{ margin: 0, fontSize: 22 }}>
              {t("agentApp.assignedMcps")}
            </h2>
            {mcps.length === 0 ? (
              <p style={{ color: "var(--ink-soft)" }}>{t("agentApp.noMcps")}</p>
            ) : (
              <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                {mcps.map((mcp) => (
                  <article key={mcp.id} style={{ padding: 14, background: "var(--parchment-2)", border: "1px solid var(--line-soft)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <strong>{mcp.name}</strong>
                      <Tag>{mcp.platform}</Tag>
                    </div>
                    <p style={{ margin: "8px 0", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>
                      {mcp.summary}
                    </p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Tag>{mcp.interactionType}</Tag>
                      {mcp.tokens.map((token) => <Tag key={token}>{token}</Tag>)}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section style={{ padding: 20, border: "1px solid var(--line)", background: "var(--parchment-2)" }}>
            <h2 className="display" style={{ margin: 0, fontSize: 22 }}>
              {t("agentApp.branding")}
            </h2>
            <label className="smallcaps" style={{ display: "block", marginTop: 16, fontSize: 10 }}>
              {t("agentApp.appName")}
            </label>
            <input
              value={appName}
              onChange={(event) => setAppName(event.target.value)}
              placeholder={agentName}
              maxLength={40}
              style={{ width: "100%", marginTop: 6, padding: 10, border: "1px solid var(--line)", background: "var(--parchment)", boxSizing: "border-box" }}
            />
            <label className="smallcaps" style={{ display: "block", marginTop: 16, fontSize: 10 }}>
              {t("agentApp.appIcon")}
            </label>
            <input
              ref={iconInput}
              type="file"
              accept="image/png"
              onChange={(event) => setIcon(event.target.files?.[0] ?? null)}
              style={{ width: "100%", marginTop: 8, fontSize: 12 }}
            />
            <p style={{ fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.4 }}>
              {t("agentApp.iconHint")}
            </p>
            {error && <p style={{ color: "var(--wine)", fontSize: 12 }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
              <Btn kind="brass" size="sm" disabled={saving} onClick={() => saveBranding(false)}>
                {saving ? t("agentApp.saving") : t("agentApp.save")}
              </Btn>
              {hasCustomIcon && (
                <Btn kind="ghost" size="sm" disabled={saving} onClick={() => saveBranding(true)}>
                  {t("agentApp.resetIcon")}
                </Btn>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
