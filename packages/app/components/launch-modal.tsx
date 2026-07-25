"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Btn, StainedPanel, Tag } from "./ornaments";
import { useT, useLocale } from "./i18n-context";

interface AgentOption {
  id: string;
  name: string;
  api_key: string | null;
}

export interface RegisterResult {
  name: string;
  contractName: string;
  mcpUrl: string;
  chainId: number;
  address: string | false;
}

const PLATFORMS = [
  { id: "claude-code",  label: "Claude Code" },
  { id: "cursor",       label: "Cursor"      },
  { id: "vscode",       label: "VS Code"     },
  { id: "windsurf",     label: "Windsurf"    },
  { id: "codex",        label: "Codex"       },
  { id: "gemini",       label: "Gemini CLI"  },
  { id: "hermes",       label: "Hermes"      },
] as const;

type PlatformId = (typeof PLATFORMS)[number]["id"];

function getConfig(
  platform: PlatformId,
  name: string,
  url: string,
  token: string,
): { code: string; file?: string } {
  const auth = { Authorization: `Bearer ${token}` };
  switch (platform) {
    case "claude-code":
      return {
        code: `claude mcp add ${name} --transport http ${url} --header "Authorization: Bearer ${token}"`,
      };
    case "cursor":
      return {
        file: "~/.cursor/mcp.json",
        code: JSON.stringify(
          { mcpServers: { [name]: { url, headers: auth } } },
          null,
          2,
        ),
      };
    case "vscode":
      return {
        file: ".vscode/mcp.json",
        code: JSON.stringify(
          { servers: { [name]: { type: "http", url, headers: auth } } },
          null,
          2,
        ),
      };
    case "windsurf":
      return {
        file: "~/.codeium/windsurf/mcp_config.json",
        code: JSON.stringify(
          { mcpServers: { [name]: { serverUrl: url, headers: auth } } },
          null,
          2,
        ),
      };
    case "codex":
      return {
        file: "~/.codex/config.yaml",
        code: `mcpServers:\n  - name: ${name}\n    url: ${url}\n    headers:\n      Authorization: "Bearer ${token}"`,
      };
    case "gemini":
      return {
        file: "~/.gemini/settings.json",
        code: JSON.stringify(
          { mcpServers: { [name]: { httpUrl: url, headers: auth } } },
          null,
          2,
        ),
      };

    case "hermes":
      return {
        file: " ~/.hermes/config.yaml",
        code: `mcp_servers:\n\tmcp_name:\n\t\turl: "${url}"\n\t\t\theaders: Authorization: "Bearer ${token}"\n\t\t\ttimeout: 120`,
      };
  }
}

export const LaunchModal = ({
  result,
  onCloseAction,
}: {
  result: RegisterResult;
  onCloseAction: () => void;
}) => {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  const [tab, setTab] = useState<PlatformId>("claude-code");
  const [copied, setCopied] = useState(false);

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json() as Promise<{ agents?: AgentOption[]; error?: string }>)
      .then((payload) => {
        setAgents(payload.agents ?? []);
        if (payload.agents?.length) setSelectedAgentId(payload.agents[0].id);
      })
      .catch(() => setAgentsError("Failed to load agents"))
      .finally(() => setAgentsLoading(false));
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const token = selectedAgent?.api_key ?? "<token>";
  const config = getConfig(tab, result.contractName, result.mcpUrl, token);
  const onClose = onCloseAction;

  const copy = () => {
    navigator.clipboard.writeText(config.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      onClick={onClose}
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
        onClick={(e) => e.stopPropagation()}
        className="launch-modal"
        style={{
          width: "min(700px, 100%)",
          background: "var(--parchment)",
          border: "1px solid var(--line)",
          borderTop: "4px solid var(--brass)",
          boxShadow: "8px 8px 0 rgba(0,0,0,0.28)",
        }}
      >
        {/* Decorated header */}
        <div
          style={{
            height: 96,
            position: "relative",
            overflow: "hidden",
            background: "var(--verdigris-deep)",
          }}
        >
          <div style={{ position: "absolute", inset: 0, opacity: 0.35 }}>
            <StainedPanel seed={result.name.length + 17} width={700} height={96} />
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              padding: "20px 24px",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                className="smallcaps"
                style={{
                  fontSize: 10,
                  color: "var(--brass-bright)",
                  letterSpacing: "0.2em",
                  marginBottom: 4,
                }}
              >
                {t("launch.registeredBadge")}
              </div>
              <h2
                className="display"
                style={{ margin: 0, fontSize: 24, color: "var(--parchment)" }}
              >
                {t("launch.title")}
              </h2>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "rgba(241,233,212,0.18)",
                border: "1px solid rgba(241,233,212,0.3)",
                cursor: "pointer",
                fontSize: 20,
                color: "var(--parchment)",
                display: "grid",
                placeItems: "center",
              }}
            >
              ×
            </button>
          </div>
        </div>

        <div className="launch-modal-body" style={{ padding: "22px 24px 28px" }}>
          {/* Registered name + URL */}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: 22,
            }}
          >
            <Tag color="var(--verdigris-deep)">✓ {result.contractName}</Tag>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-soft)", wordBreak: "break-all" }}
            >
              {result.mcpUrl}
            </span>
          </div>

          {/* Agent selector + API key */}
          <div
            style={{
              marginBottom: 20,
              padding: "14px 14px 12px",
              background: "rgba(184,137,58,0.07)",
              border: "1px solid var(--brass)",
            }}
          >
            <div
              className="smallcaps"
              style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--brass-deep)", marginBottom: 10 }}
            >
              {t("launch.selectAgentLabel")}
            </div>

            {/* Agent dropdown */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              {agentsLoading ? (
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>{t("launch.loadingAgents")}</span>
              ) : agentsError ? (
                <span className="mono" style={{ fontSize: 11, color: "var(--brass-deep)" }}>{agentsError}</span>
              ) : agents.length === 0 ? (
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                  {t("launch.noAgents").split("—")[0]}—{" "}
                  <button
                    onClick={() => { onClose(); router.push(`/${locale}/profile?tab=agents`); }}
                    style={{ background: "none", border: "none", color: "var(--brass-deep)", cursor: "pointer", font: "inherit", padding: 0, textDecoration: "underline" }}
                  >
                    {t("launch.noAgents").split("— ")[1]}
                  </button>
                </span>
              ) : (
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "7px 10px",
                    background: "var(--parchment)",
                    border: "1px solid var(--line)",
                    fontFamily: "var(--font-ui)",
                    fontSize: 13,
                    color: "var(--ink)",
                    cursor: "pointer",
                  }}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Platform tabs */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--line)",
              marginBottom: 20,
              overflowX: "auto",
            }}
          >
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                onClick={() => setTab(p.id)}
                className="smallcaps"
                style={{
                  padding: "10px 16px",
                  fontSize: 11,
                  fontFamily: "var(--font-ui)",
                  border: "none",
                  borderBottom:
                    tab === p.id
                      ? "2px solid var(--brass-deep)"
                      : "2px solid transparent",
                  background:
                    tab === p.id ? "rgba(184,137,58,0.08)" : "transparent",
                  color: tab === p.id ? "var(--ink)" : "var(--ink-soft)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  marginBottom: -1,
                  letterSpacing: "0.12em",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* File path hint */}
          {config.file && (
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 8 }}
            >
              {config.file}
            </div>
          )}

          {/* Code block */}
          <div style={{ position: "relative" }}>
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: "16px 52px 16px 16px",
                background: "var(--ink)",
                color: "var(--brass-bright)",
                fontSize: 12.5,
                lineHeight: 1.65,
                overflow: "auto",
                borderRadius: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {config.code}
            </pre>
            <button
              onClick={copy}
              className="smallcaps"
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                padding: "4px 10px",
                fontSize: 10,
                fontFamily: "var(--font-ui)",
                background: copied
                  ? "var(--verdigris)"
                  : "rgba(241,233,212,0.1)",
                color: copied ? "var(--parchment)" : "var(--ink-soft)",
                border: `1px solid ${copied
                  ? "var(--verdigris-deep)"
                  : "rgba(241,233,212,0.22)"
                  }`,
                cursor: "pointer",
                letterSpacing: "0.12em",
              }}
            >
              {copied ? t("launch.copied") : t("launch.copy")}
            </button>
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              marginTop: 22,
            }}
          >
            <Btn kind="ghost" onClick={onClose}>
              {t("launch.close")}
            </Btn>
            <Btn
              kind="brass"
              onClick={() => {
                onClose();
                router.push(`/${locale}/explore`);
              }}
            >
              {t("launch.viewInRegistry")}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
};
