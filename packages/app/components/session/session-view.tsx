"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { UIMessage } from "ai";
import { useT } from "@/components/i18n-context";
import { Btn } from "@/components/ornaments";
import { ChatBox } from "./chat-box";
import { McpConfigPanel, type ApplyResult, type McpSelectionItem } from "./mcp-config-panel";
import { McpPicker } from "./mcp-picker";
import { readTranscript, writeTranscript } from "./transcript-store";

type Phase = "loading" | "wizard" | "starting" | "chat" | "error";

type StartResponse = {
  sessionId: string;
  acpSessionId: string;
  resumed: boolean;
  mcps: McpSelectionItem[];
  error?: string;
};

// Same mapping in both start paths, so an unreachable registry or a keyless agent reads the
// same whether it surfaced from the wizard or from an automatic resume.
const messageForStatus = (
  status: number,
  fallback: string | undefined,
  t: (k: string) => string,
): string => {
  if (status === 503) return t("session.errorRuntime");
  if (status === 409) return t("session.errorNoKey");
  if (status === 502) return t("session.errorRegistry");
  return fallback ?? t("session.errorStart");
};

export function SessionView({
  agentId,
  agentName,
  userId,
  lang,
}: {
  agentId: string;
  agentName: string;
  userId: string;
  lang: string;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mcps, setMcps] = useState<McpSelectionItem[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [restored, setRestored] = useState<UIMessage[]>([]);
  const [divider, setDivider] = useState(false);
  const [turnBusy, setTurnBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [ending, setEnding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // Filled by ChatBox while it is mounted; the seam Reset uses to empty the thread without
  // remounting it.
  const clearChat = useRef<(() => void) | null>(null);

  const start = useCallback(
    async (mcpNames: string[] | undefined) => {
      // localStorage is read here, in a callback — never during render, which would be a
      // hydration mismatch under Next 16's server render of this component.
      const stored = readTranscript(userId, agentId);
      setPendingCount(mcpNames ? mcpNames.length : mcps.length);
      setPhase("starting");
      setError(null);
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            ...(mcpNames ? { mcpNames } : {}),
            ...(stored.acpSessionId ? { acpSessionId: stored.acpSessionId } : {}),
          }),
        });
        const payload = (await res.json()) as StartResponse;
        if (!res.ok) {
          setError(messageForStatus(res.status, payload.error, t));
          setPhase("error");
          return;
        }
        setSessionId(payload.sessionId);
        setMcps(payload.mcps);
        setSelection(payload.mcps.map((m) => m.mcpName));
        setRestored(stored.messages);
        // Honest about a session that aged out or a wiped dir: without the divider the UI
        // shows history the agent cannot see, and the user finds out by being contradicted.
        setDivider(!payload.resumed && stored.messages.length > 0);
        writeTranscript(userId, agentId, {
          acpSessionId: payload.acpSessionId,
          messages: stored.messages,
        });
        setPhase("chat");
      } catch {
        setError(t("session.errorStart"));
        setPhase("error");
      }
    },
    [agentId, userId, mcps.length, t],
  );

  // Mount: is this agent configured yet? No sync setState in the effect body.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    let live = true;
    fetch(`/api/agents/${agentId}/mcps`)
      .then((r) => r.json() as Promise<{ configured?: boolean; mcps?: McpSelectionItem[] }>)
      .then((d) => {
        if (!live) return;
        if (d.configured) {
          setMcps(d.mcps ?? []);
          setSelection((d.mcps ?? []).map((m) => m.mcpName));
          void start(undefined);
        } else {
          setPhase("wizard");
        }
      })
      .catch(() => {
        if (live) {
          setError(t("session.errorStart"));
          setPhase("error");
        }
      });
    return () => {
      live = false;
    };
  }, [agentId, start, t]);

  const persist = useCallback(
    (messages: UIMessage[]) => {
      const stored = readTranscript(userId, agentId);
      writeTranscript(userId, agentId, { acpSessionId: stored.acpSessionId, messages });
    },
    [userId, agentId],
  );

  const onApplied = useCallback(
    (result: ApplyResult) => {
      setSessionId(result.sessionId);
      setMcps(result.mcps);
      setSelection(result.mcps.map((m) => m.mcpName));
      setDivider(!result.resumed);
      const stored = readTranscript(userId, agentId);
      writeTranscript(userId, agentId, {
        acpSessionId: result.acpSessionId,
        messages: stored.messages,
      });
    },
    [userId, agentId],
  );

  // Reset keeps the agent connected and forgets the conversation. It is the one control here
  // that destroys something the user cannot get back, so it confirms.
  const doReset = async () => {
    if (!sessionId) return;
    if (!window.confirm(t("session.resetConfirm"))) return;
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch(`/api/session/${sessionId}/reset`, { method: "POST" });
      if (!res.ok) {
        // A reset that fails silently is indistinguishable from a button that does nothing.
        setResetError(
          res.status === 410
            ? t("session.expired")
            : res.status === 409
              ? t("session.resetBusy")
              : t("session.resetFailed"),
        );
        return;
      }
      const { acpSessionId } = (await res.json()) as { acpSessionId: string };
      writeTranscript(userId, agentId, { acpSessionId, messages: [] });
      setRestored([]);
      setDivider(false);
      // In place, not by remounting: the process — and so the client's sessionId — is
      // unchanged, which is the point of Reset.
      clearChat.current?.();
    } catch {
      setResetError(t("session.resetFailed"));
    } finally {
      setResetting(false);
    }
  };

  // End session disconnects and keeps nothing running.
  const doEnd = async () => {
    if (!sessionId) return;
    setEnding(true);
    try {
      await fetch(`/api/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // best effort; the sweeper is the backstop
    } finally {
      setEnding(false);
      setSessionId(null);
      setPhase("wizard");
    }
  };

  const backLink = (
    <Link
      href={`/${lang}/profile?tab=agents`}
      style={{ fontSize: 12.5, color: "var(--ink-soft)", textDecoration: "none" }}
    >
      {t("session.back")}
    </Link>
  );

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 20px 56px" }}>
      <div style={{ marginBottom: 8 }}>{backLink}</div>
      <h1
        className="smallcaps"
        style={{ fontSize: 22, color: "var(--ink)", margin: "0 0 20px" }}
      >
        {t("session.title", { name: agentName })}
      </h1>

      {phase === "loading" ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{t("session.loading")}</div>
      ) : null}

      {phase === "wizard" ? (
        <div style={{ border: "1px solid var(--line)", padding: 20 }}>
          <McpPicker
            selected={selection}
            onChange={setSelection}
            title={t("session.wizardTitle")}
            subtitle={t("session.wizardSubtitle")}
            action={{ label: t("session.wizardStart"), onClick: () => void start(selection) }}
          />
        </div>
      ) : null}

      {phase === "starting" ? (
        <div style={{ border: "1px solid var(--line)", padding: 20, fontSize: 13 }}>
          {/* Not fast: with acp_enable_mcp on, session/new pays the MCP connection cost for
              every server in the bundle before it returns. */}
          {pendingCount > 0
            ? t("session.connecting", { n: pendingCount })
            : t("session.connectingNone")}
        </div>
      ) : null}

      {phase === "error" ? (
        <div
          style={{
            border: "1px solid rgba(138,53,38,0.35)",
            background: "rgba(138,53,38,0.10)",
            padding: 16,
            fontSize: 13,
            color: "var(--wine)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{error ?? t("session.errorStart")}</span>
          <Btn size="sm" kind="ghost" onClick={() => setPhase("wizard")}>
            {t("session.restart")}
          </Btn>
        </div>
      ) : null}

      {phase === "chat" && sessionId ? (
        <ChatBox
          key={sessionId}
          sessionId={sessionId}
          initialMessages={restored}
          divider={divider}
          onMessages={persist}
          onExpired={() => void start(undefined)}
          onBusyChange={setTurnBusy}
          clearRef={clearChat}
          header={
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <McpConfigPanel
                agentId={agentId}
                mcps={mcps}
                busy={turnBusy}
                onApplied={onApplied}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Btn
                  size="sm"
                  kind="ghost"
                  disabled={turnBusy || resetting}
                  onClick={() => void doReset()}
                >
                  {resetting ? t("session.resetting") : t("session.reset")}
                </Btn>
                <Btn
                  size="sm"
                  kind="ghost"
                  disabled={ending}
                  onClick={() => void doEnd()}
                  style={{ color: "var(--wine)" }}
                >
                  {ending ? t("session.ending") : t("session.end")}
                </Btn>
              </div>
              {resetError ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--wine)",
                    textAlign: "right",
                  }}
                >
                  {resetError}
                </div>
              ) : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
}
