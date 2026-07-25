"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Mcp } from "@/components/data";
import { SHORT_ADDR } from "@/components/data";
import { useT } from "@/components/i18n-context";
import { Btn, Pill } from "@/components/ornaments";

export type PickerAction = {
  label: string;
  onClick: () => void;
  busy?: boolean;
  busyLabel?: string;
};

// Presentational: the selection state and the submit handler come from props, so the wizard
// and the in-chat panel are the same component with different actions.
export function McpPicker({
  selected,
  onChange,
  action,
  title,
  subtitle,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  action: PickerAction;
  title?: string;
  subtitle?: string;
}) {
  const t = useT();
  const [mcps, setMcps] = useState<Mcp[] | null>(null);
  const [filter, setFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // No synchronous setState in the effect body (react-hooks/set-state-in-effect is an error
  // here) — the reset to "loading" is expressed by bumping reloadKey from the retry handler.
  useEffect(() => {
    let live = true;
    fetch("/api/mcps")
      .then((r) => r.json() as Promise<{ mcps?: Mcp[] }>)
      .then((d) => {
        if (live) setMcps(d.mcps ?? []);
      })
      .catch(() => {
        if (live) setMcps([]);
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setMcps(null);
    setReloadKey((k) => k + 1);
  }, []);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = (mcps ?? []).filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.contract.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    );
    const byChain = new Map<string, Mcp[]>();
    for (const m of rows) byChain.set(m.chain, [...(byChain.get(m.chain) ?? []), m]);
    return [...byChain.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mcps, filter]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  const loading = mcps === null;
  // fetchMcps swallows every failure and returns [], so an unset REGISTRY_URL, an
  // unreachable registry and a genuinely empty registry are indistinguishable here. Say so
  // rather than showing a bare list that reads as "you have nothing to pick".
  const empty = !loading && (mcps?.length ?? 0) === 0;

  return (
    <div>
      {title ? (
        <div
          className="smallcaps"
          style={{ fontSize: 15, color: "var(--ink)", marginBottom: 6 }}
        >
          {title}
        </div>
      ) : null}
      {subtitle ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 }}>
          {subtitle}
        </div>
      ) : null}

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)", padding: "12px 0" }}>
          {t("session.loading")}
        </div>
      ) : empty ? (
        <div
          style={{
            border: "1px solid var(--line)",
            padding: 16,
            fontSize: 13,
            color: "var(--ink-soft)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{t("session.catalogEmpty")}</span>
          <Btn size="sm" kind="ghost" onClick={retry}>
            {t("session.catalogRetry")}
          </Btn>
        </div>
      ) : (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("session.filterPlaceholder")}
            style={{
              width: "100%",
              padding: "9px 12px",
              fontSize: 13,
              fontFamily: "var(--font-ui)",
              background: "transparent",
              color: "var(--ink)",
              border: "1px solid var(--line)",
              marginBottom: 12,
            }}
          />
          <div style={{ maxHeight: 320, overflowY: "auto", paddingRight: 4 }}>
            {groups.map(([chain, rows]) => (
              <div key={chain} style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 6 }}>
                  <Pill tone="brass">{chain}</Pill>
                </div>
                {rows.map((m) => {
                  const checked = selected.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 10,
                        padding: "7px 8px",
                        cursor: "pointer",
                        borderBottom: "1px solid var(--line)",
                        background: checked ? "rgba(184,137,58,0.08)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(m.id)}
                        style={{ accentColor: "var(--brass-deep)" }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13.5, color: "var(--ink)" }}>
                          {m.name || m.id}
                        </span>
                        {m.contract ? (
                          <span
                            className="mono"
                            style={{
                              fontSize: 11.5,
                              color: "var(--ink-soft)",
                              marginLeft: 8,
                            }}
                          >
                            {SHORT_ADDR(m.contract)}
                          </span>
                        ) : null}
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                        {m.interfaces}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 14,
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
          {t("session.selectedCount", { n: selected.length })}
        </span>
        <Btn size="sm" kind="brass" disabled={action.busy} onClick={action.onClick}>
          {action.busy ? (action.busyLabel ?? action.label) : action.label}
        </Btn>
      </div>
    </div>
  );
}
