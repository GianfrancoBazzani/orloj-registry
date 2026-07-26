"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n-context";
import { Btn } from "./ornaments";

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

type Busy = "idle" | "saving" | "installing";

export function InstallAppModal({
  agentId,
  agentName,
  appName: savedAppName,
  hasCustomIcon,
  canPrompt,
  onCloseAction,
  onInstallAction,
  onSavedAction,
}: {
  agentId: string;
  agentName: string;
  appName: string | null;
  hasCustomIcon: boolean;
  canPrompt: boolean;
  onCloseAction: () => void;
  /** Refreshes the manifest, then raises the browser's install prompt against it. */
  onInstallAction: () => Promise<InstallOutcome>;
  /** Branding was written; anything rendering the icon by URL has to re-fetch it. */
  onSavedAction?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const iconInput = useRef<HTMLInputElement>(null);
  const [appName, setAppName] = useState(savedAppName ?? "");
  const [icon, setIcon] = useState<File | null>(null);
  const [clearIcon, setClearIcon] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  // The browser-menu route is only worth explaining once we know no prompt is coming.
  const [showFallback, setShowFallback] = useState(!canPrompt);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const savedIcon = hasCustomIcon && !clearIcon;
  const shownIcon =
    previewUrl ?? (savedIcon ? `/api/agents/${agentId}/icon` : "/logo.png");

  // The blob URL is minted here rather than in an effect so the preview swaps in the same
  // render as the file, with the ref keeping the previous one alive only long enough to revoke.
  const showPreview = (file: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = file ? URL.createObjectURL(file) : null;
    setPreviewUrl(previewRef.current);
  };

  const pickIcon = (file: File | null) => {
    setIcon(file);
    showPreview(file);
    if (file) setClearIcon(false);
    setError(null);
  };

  const resetIcon = () => {
    setIcon(null);
    showPreview(null);
    setClearIcon(true);
    setError(null);
    if (iconInput.current) iconInput.current.value = "";
  };

  const save = async (): Promise<boolean> => {
    const form = new FormData();
    form.set("appName", appName);
    if (icon) form.set("icon", icon);
    if (clearIcon && !icon) form.set("clearIcon", "true");
    try {
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
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t("agentApp.saveFailed"),
      );
      return false;
    }
  };

  const saveAndInstall = async () => {
    if (busy !== "idle") return;
    setBusy("saving");
    setError(null);
    if (!(await save())) {
      setBusy("idle");
      return;
    }
    // Pulls the stored name and icon back down, so reopening this modal shows what was saved
    // even if the install itself is declined.
    router.refresh();
    onSavedAction?.();

    setBusy("installing");
    const outcome = await onInstallAction();
    if (outcome === "accepted") {
      onCloseAction();
      return;
    }
    setBusy("idle");
    if (outcome === "unavailable") setShowFallback(true);
  };

  const label = {
    idle: t("agentApp.saveAndInstall"),
    saving: t("agentApp.saving"),
    installing: t("agentApp.installing"),
  }[busy];

  return (
    <div
      onClick={busy === "idle" ? onCloseAction : undefined}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,22,18,0.65)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="launch-modal"
        style={{
          width: "min(520px, 100%)",
          background: "var(--parchment)",
          border: "1px solid var(--line)",
          borderTop: "4px solid var(--brass)",
          boxShadow: "8px 8px 0 rgba(0,0,0,0.28)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "20px 24px 0",
          }}
        >
          <div>
            <div
              className="smallcaps"
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                color: "var(--brass-deep)",
              }}
            >
              {agentName}
            </div>
            <h2 className="display" style={{ margin: "4px 0 0", fontSize: 24 }}>
              {t("agentApp.installTitle")}
            </h2>
          </div>
          <button
            onClick={onCloseAction}
            disabled={busy !== "idle"}
            aria-label={t("agentApp.cancel")}
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "transparent",
              border: "1px solid var(--line)",
              cursor: busy === "idle" ? "pointer" : "not-allowed",
              fontSize: 18,
              color: "var(--ink-soft)",
              display: "grid",
              placeItems: "center",
              flex: "0 0 auto",
            }}
          >
            ×
          </button>
        </div>

        <div className="launch-modal-body" style={{ padding: "16px 24px 24px" }}>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--ink-soft)",
            }}
          >
            {t("agentApp.installIntro")}
          </p>

          <label
            className="smallcaps"
            htmlFor="install-app-name"
            style={{ display: "block", marginTop: 18, fontSize: 10 }}
          >
            {t("agentApp.appName")}
          </label>
          <input
            id="install-app-name"
            value={appName}
            onChange={(event) => setAppName(event.target.value)}
            placeholder={agentName}
            maxLength={40}
            style={{
              width: "100%",
              marginTop: 6,
              padding: 10,
              border: "1px solid var(--line)",
              background: "var(--parchment-2)",
              boxSizing: "border-box",
            }}
          />

          <div className="smallcaps" style={{ marginTop: 18, fontSize: 10 }}>
            {t("agentApp.appIcon")}
          </div>
          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "center",
              marginTop: 8,
            }}
          >
            {/* Plain img: the source is either a blob URL or a private API route, neither of
                which next/image can optimise. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={shownIcon}
              alt=""
              width={64}
              height={64}
              style={{
                width: 64,
                height: 64,
                objectFit: "contain",
                border: "1px solid var(--line)",
                background: "var(--parchment-2)",
                padding: 4,
                flex: "0 0 auto",
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <input
                ref={iconInput}
                type="file"
                accept="image/png"
                onChange={(event) => pickIcon(event.target.files?.[0] ?? null)}
                style={{ width: "100%", fontSize: 12 }}
              />
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: "var(--ink-soft)",
                }}
              >
                {t("agentApp.iconHint")}
              </p>
            </div>
          </div>
          {savedIcon && (
            <Btn kind="ghost" size="sm" onClick={resetIcon}>
              {t("agentApp.resetIcon")}
            </Btn>
          )}

          {error && (
            <p style={{ marginTop: 14, fontSize: 12, color: "var(--wine)" }}>
              {error}
            </p>
          )}
          {showFallback && (
            <p
              style={{
                marginTop: 14,
                fontSize: 11,
                lineHeight: 1.4,
                color: "var(--ink-soft)",
              }}
            >
              {t("agentApp.installFallback")}
            </p>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              marginTop: 22,
            }}
          >
            <Btn kind="ghost" disabled={busy !== "idle"} onClick={onCloseAction}>
              {t("agentApp.cancel")}
            </Btn>
            <Btn kind="brass" disabled={busy !== "idle"} onClick={saveAndInstall}>
              {label}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
