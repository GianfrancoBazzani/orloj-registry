"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/components/i18n-context";
import { Btn } from "@/components/ornaments";
import type { PickerAction } from "./mcp-picker";

export type CatalogSkill = {
  name: string;
  description: string;
  sizeBytes: number;
  contentHash: string;
  fileCount: number;
};

export type SkillCatalog = {
  skills: CatalogSkill[];
  network: { chainId: number; name: string };
  indexRoot: string;
  publisher?: string;
  explorer: { publisher?: string; indexTx: string };
};

const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;
const shortHash = (h: string): string => `${h.slice(0, 8)}…${h.slice(-4)}`;
const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Presentational, exactly like McpPicker: selection state and the submit handler are props,
// so the panel owns the lifecycle and this file stays about rendering.
export function SkillPicker({
  selected,
  onChange,
  action,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  action: PickerAction;
}) {
  const t = useT();
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // No synchronous setState in the effect body — react-hooks/set-state-in-effect is an error
  // in this config, so a retry bumps reloadKey instead of resetting state here.
  useEffect(() => {
    let live = true;
    fetch("/api/skills")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as SkillCatalog;
      })
      .then((d) => {
        if (live) setCatalog(d);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setCatalog(null);
    setFailed(false);
    setReloadKey((k) => k + 1);
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (catalog?.skills ?? []).filter(
      (s) =>
        !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  // Only what still has to be fetched. A skill already installed costs nothing to keep, and
  // quoting its bytes again would overstate what Apply is about to do.
  const downloadBytes = useMemo(
    () =>
      (catalog?.skills ?? [])
        .filter((s) => selected.includes(s.name))
        .reduce((acc, s) => acc + s.sizeBytes, 0),
    [catalog, selected],
  );

  const toggle = (name: string) =>
    onChange(
      selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name],
    );

  return (
    <div>
      {catalog === null && !failed ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)", padding: "12px 0" }}>
          {t("session.skillsLoading")}
        </div>
      ) : failed || (catalog?.skills.length ?? 0) === 0 ? (
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
          <span>{t("session.skillsCatalogEmpty")}</span>
          <Btn size="sm" kind="ghost" onClick={retry}>
            {t("session.catalogRetry")}
          </Btn>
        </div>
      ) : (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("session.skillsFilterPlaceholder")}
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
            {rows.map((s) => {
              const checked = selected.includes(s.name);
              return (
                <label
                  key={s.name}
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
                    onChange={() => toggle(s.name)}
                    style={{ accentColor: "var(--brass-deep)" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, color: "var(--ink)" }}>{s.name}</span>
                    <span
                      style={{
                        display: "block",
                        fontSize: 11.5,
                        color: "var(--ink-soft)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.description}
                    </span>
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                    {kb(s.sizeBytes)}
                  </span>
                </label>
              );
            })}
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
          {t("session.skillsDownloadNote", {
            n: selected.length,
            size: kb(downloadBytes),
          })}
        </span>
        <Btn size="sm" kind="brass" disabled={action.busy} onClick={action.onClick}>
          {action.busy ? (action.busyLabel ?? action.label) : action.label}
        </Btn>
      </div>

      {/* Provenance. Only these two links exist: StorageScan has no working per-root-hash
          view (/file/<root>, /file-detail/<root> and /search?keyword=<root> all 404), so
          there is nothing to link for an individual skill. Both come from the catalog
          payload, never hardcoded here. */}
      {catalog ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--line)",
            fontSize: 11.5,
            color: "var(--ink-soft)",
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span className="mono">
            {t("session.skillsProvenance", {
              n: catalog.skills.length,
              root: shortHash(catalog.indexRoot),
              network: catalog.network.name,
            })}
          </span>
          <span style={{ flex: 1 }} />
          {catalog.explorer.publisher && catalog.publisher ? (
            <a
              href={catalog.explorer.publisher}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--brass-deep)" }}
            >
              {t("session.skillsPublishedBy", { addr: shortAddr(catalog.publisher) })} ↗
            </a>
          ) : null}
          <a
            href={catalog.explorer.indexTx}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--brass-deep)" }}
          >
            {t("session.skillsIndexTx")} ↗
          </a>
        </div>
      ) : null}
    </div>
  );
}
