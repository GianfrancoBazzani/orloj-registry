"use client";
import { useState } from "react";
import { useT } from "@/components/i18n-context";
import { Btn, Pill } from "@/components/ornaments";
import type { ApplyResult } from "./mcp-config-panel";
import { SkillPicker } from "./skill-picker";

export type SkillApplyResult = ApplyResult & {
  skills: string[];
};

// Sibling of McpConfigPanel, deliberately not merged with it: a slow or failing 0G fetch must
// never be able to block an MCP change, and each panel's error mapping stays small.
export function SkillConfigPanel({
  agentId,
  skills,
  busy,
  onApplied,
}: {
  agentId: string;
  skills: string[];
  busy: boolean;
  onApplied: (result: SkillApplyResult) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string[]>(() => skills);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/skills`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillNames: selection }),
      });
      const payload = (await res.json()) as SkillApplyResult & {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        setError(
          payload.code === "zg_unreachable"
            ? t("session.errorZgUnreachable")
            : payload.code === "verification_failed"
              ? t("session.errorSkillVerification")
              : payload.code === "session_busy"
                ? t("session.resetBusy")
                : res.status === 503
                  ? t("session.errorRuntime")
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="smallcaps" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          {t("session.skillsCount", { n: skills.length })}
        </span>
        {skills.map((name) => (
          <Pill key={name} tone="brass">
            {name}
          </Pill>
        ))}
        <span style={{ flex: 1 }} />
        {/* Disabled mid-turn for the same reason the MCP panel is: applying respawns the
            agent, which would drop a reply the user is watching arrive. */}
        <Btn
          size="sm"
          kind="ghost"
          disabled={busy || applying}
          onClick={() => setOpen((v) => !v)}
        >
          {t("session.skillsPanelToggle")}
        </Btn>
      </div>

      {open ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <SkillPicker
            selected={selection}
            onChange={setSelection}
            action={{
              label: t("session.panelApply"),
              onClick: () => void apply(),
              busy: applying,
              busyLabel: t("session.panelApplying"),
            }}
          />
          {/* Applying carries acpSessionId through the respawn, exactly as an MCP apply
              does, so the same note is the honest one. */}
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
