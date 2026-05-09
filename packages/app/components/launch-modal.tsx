"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, StainedPanel, Tag } from "./ornaments";

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
] as const;

type PlatformId = (typeof PLATFORMS)[number]["id"];

function getConfig(
  platform: PlatformId,
  name: string,
  url: string,
): { code: string; file?: string } {
  const servers = { [name]: { url } };
  switch (platform) {
    case "claude-code":
      return { code: `claude mcp add --transport http ${name} ${url}` };
    case "cursor":
      return {
        file: "~/.cursor/mcp.json",
        code: JSON.stringify({ mcpServers: servers }, null, 2),
      };
    case "vscode":
      return {
        file: ".vscode/mcp.json",
        code: JSON.stringify(
          { servers: { [name]: { type: "http", url } } },
          null,
          2,
        ),
      };
    case "windsurf":
      return {
        file: "~/.codeium/windsurf/mcp_config.json",
        code: JSON.stringify(
          { mcpServers: { [name]: { serverUrl: url } } },
          null,
          2,
        ),
      };
    case "codex":
      return {
        file: "~/.codex/config.yaml",
        code: `mcpServers:\n  - name: ${name}\n    url: ${url}`,
      };
    case "gemini":
      return {
        file: "~/.gemini/settings.json",
        code: JSON.stringify(
          { mcpServers: { [name]: { httpUrl: url } } },
          null,
          2,
        ),
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
  const [tab, setTab] = useState<PlatformId>("claude-code");
  const [copied, setCopied] = useState(false);
  const config = getConfig(tab, result.contractName, result.mcpUrl);
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
                ✦ interface registered ✦
              </div>
              <h2
                className="display"
                style={{ margin: 0, fontSize: 24, color: "var(--parchment)" }}
              >
                Bind to your agent
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

        <div style={{ padding: "22px 24px 28px" }}>
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
                border: `1px solid ${
                  copied
                    ? "var(--verdigris-deep)"
                    : "rgba(241,233,212,0.22)"
                }`,
                cursor: "pointer",
                letterSpacing: "0.12em",
              }}
            >
              {copied ? "✓ copied" : "copy"}
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
              Close
            </Btn>
            <Btn
              kind="brass"
              onClick={() => {
                onClose();
                router.push("/explore");
              }}
            >
              View in registry →
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
};
