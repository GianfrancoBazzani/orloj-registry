"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAuth } from "./auth-context";
import { useT } from "./i18n-context";
import { InstallAppModal, type InstallOutcome } from "./install-app-modal";
import { Btn } from "./ornaments";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>;
}

// How long to wait for the browser to re-offer a prompt after the manifest changes. Chrome
// re-runs its installability check off the main flow, so the fresh event lands a beat later.
const PROMPT_REFRESH_MS = 2000;

const STANDALONE = "(display-mode: standalone)";

// Touch as the *primary* pointer — phones and tablets. A touchscreen laptop still reports a fine
// primary pointer, so it reads as desktop, which is what we want: a home-screen app only earns
// its keep on a device that has a home screen.
const MOBILE = "(pointer: coarse)";

// Read through the store rather than in state: the server cannot know the display mode or the
// pointer type, and its snapshot of `false` is what hydration matches against.
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
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

// Owns the manifest link as well as the bar: the install button names the app and its icon
// through this manifest, so the two have to move together. A browser only offers to install
// from inside the manifest's scope, which is this page — the chat — and nowhere else.
export function AgentAppBar({
  agentId,
  agentName,
  appName,
  hasCustomIcon,
  lang,
}: {
  agentId: string;
  agentName: string;
  appName: string | null;
  hasCustomIcon: boolean;
  lang: string;
}) {
  const t = useT();
  const [manifestVersion, setManifestVersion] = useState(0);
  // Busts the bar's icon after a branding save. Replacing one PNG with another leaves the URL
  // untouched, so React would keep showing the bitmap it already painted.
  const [iconVersion, setIconVersion] = useState(0);
  const [canPrompt, setCanPrompt] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [open, setOpen] = useState(false);
  // Launched from the home screen, or installed a moment ago in this tab.
  const installed = useMediaQuery(STANDALONE) || justInstalled;
  const mobile = useMediaQuery(MOBILE);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const waiterRef = useRef<((event: BeforeInstallPromptEvent) => void) | null>(
    null,
  );

  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      promptRef.current = event as BeforeInstallPromptEvent;
      setCanPrompt(true);
      const waiter = waiterRef.current;
      waiterRef.current = null;
      waiter?.(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      promptRef.current = null;
      setCanPrompt(false);
      setJustInstalled(true);
      setOpen(false);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // A browser parses the manifest once per page load, so installing straight after a branding
  // save would carry the previous name and icon. Changing the link's href makes it re-fetch the
  // manifest and re-run its installability check, which re-fires `beforeinstallprompt` — this
  // time describing the app the owner just saved.
  const install = async (): Promise<InstallOutcome> => {
    setManifestVersion((version) => version + 1);
    const refreshed = await new Promise<BeforeInstallPromptEvent | null>(
      (resolve) => {
        waiterRef.current = resolve;
        window.setTimeout(() => {
          if (waiterRef.current !== resolve) return;
          waiterRef.current = null;
          resolve(null);
        }, PROMPT_REFRESH_MS);
      },
    );
    // Falling back to the pre-save event keeps the install working on browsers that do not
    // re-offer one; it just describes the app as it was a moment ago.
    const event = refreshed ?? promptRef.current;
    if (!event) return "unavailable";
    promptRef.current = null;
    setCanPrompt(false);
    try {
      const { outcome } = await event.prompt();
      return outcome;
    } catch {
      // A prompt already consumed, or no longer installable.
      return "unavailable";
    }
  };

  const manifestHref =
    `/api/agents/${encodeURIComponent(agentId)}/manifest.webmanifest` +
    `?lang=${encodeURIComponent(lang)}&v=${manifestVersion}`;

  return (
    <>
      {/* React hoists this into <head>, so the manifest is declared from first paint even though
          the version that busts it lives in client state. Credentialed because the manifest is
          owner-checked and private. */}
      <link rel="manifest" href={manifestHref} crossOrigin="use-credentials" />
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "20px 20px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 10,
        }}
      >
        {/* The Orloj mark, same as every other page's chrome. */}
        <Image
          src="/logo.png"
          alt="Orloj"
          width={32}
          height={32}
          style={{ marginRight: "auto" }}
        />
        {mobile && !installed && (
          <Btn kind="brass" size="sm" onClick={() => setOpen(true)}>
            {t("agentApp.install")}
          </Btn>
        )}
        {/* The app's own face, at the corner where a phone shows it. Only on mobile, where the
            installed app is a real possibility, and only once the owner has uploaded something:
            with no upload the manifest icon *is* the Orloj mark already sitting on the left.
            Plain img — next/image cannot optimise a private, credentialed API route. */}
        {mobile && hasCustomIcon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/agents/${encodeURIComponent(agentId)}/icon?v=${iconVersion}`}
            alt={t("agentApp.appIcon")}
            width={32}
            height={32}
            style={{
              width: 32,
              height: 32,
              objectFit: "cover",
              // Uploads are validated square, so the circular mask the home screen applies is
              // safe to mirror here.
              borderRadius: "50%",
              border: "1px solid var(--line)",
              flex: "0 0 auto",
            }}
          />
        )}
      </div>
      {open && (
        <InstallAppModal
          agentId={agentId}
          agentName={agentName}
          appName={appName}
          hasCustomIcon={hasCustomIcon}
          canPrompt={canPrompt}
          onCloseAction={() => setOpen(false)}
          onInstallAction={install}
          onSavedAction={() => setIconVersion((version) => version + 1)}
        />
      )}
    </>
  );
}
