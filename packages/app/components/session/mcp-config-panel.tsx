"use client";
import { useState } from "react";
import { useT } from "@/components/i18n-context";
import { Btn, Pill } from "@/components/ornaments";
import { McpPicker } from "./mcp-picker";

export type McpSelectionItem = { mcpName: string; serverName: string };

export type ApplyResult = {
  sessionId: string;
  acpSessionId: string;
  resumed: boolean;
  mcps: McpSelectionItem[];
};

export function McpConfigPanel({
  agentId,
  mcps,
  busy,
  onApplied,
}: {
  agentId: string;
  mcps: McpSelectionItem[];
  busy: boolean;
  onApplied: (result: ApplyResult) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string[]>(() => mcps.map((m) => m.mcpName));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/mcps`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpNames: selection }),
      });
      const payload = (await res.json()) as ApplyResult & { error?: string };
      if (!res.ok) {
        setError(
          res.status === 503
            ? t("session.errorRuntime")
            : res.status === 409
              ? t("session.errorNoKey")
              : res.status === 502
                ? t("session.errorRegistry")
                : (payload.error ?? t("session.errorStart")),
        );
        return;
      }
      onApplied(payload);
      setOpen(false);
    } catch {
      setError(t("session.errorStart"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--line)", padding: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span className="smallcaps" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          {t("session.connectedCount", { n: mcps.length })}
        </span>
        {mcps.map((m) => (
          <Pill key={m.mcpName} tone="verdigris">
            {m.serverName}
          </Pill>
        ))}
        <span style={{ flex: 1 }} />
        {/* Disabled while a turn is in flight — restarting mid-stream would drop a reply the
            user is watching arrive. */}
        <Btn
          size="sm"
          kind="ghost"
          disabled={busy || applying}
          onClick={() => setOpen((v) => !v)}
        >
          {t("session.panelToggle")}
        </Btn>
      </div>

      {open ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <McpPicker
            selected={selection}
            onChange={setSelection}
            action={{
              label: t("session.panelApply"),
              onClick: () => void apply(),
              busy: applying,
              busyLabel: t("session.panelApplying"),
            }}
          />
          {/* Probing confirmed session/load re-initializes the mcp_bundles tools, so Apply
              carries the conversation across the respawn. */}
          <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 10 }}>
            {t("session.panelNoteKeepsThread")}
          </div>
          {error ? (
            <div style={{ fontSize: 12.5, color: "var(--wine)", marginTop: 8 }}>{error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
