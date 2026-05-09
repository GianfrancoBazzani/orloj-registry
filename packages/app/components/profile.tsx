"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "./auth-context";
import { authClient } from "@/lib/auth-client";
import {
  Pill,
  Btn,
  Identicon,
  Field,
  Input,
  Select,
  GearIcon,
  OrlojMark,
} from "./ornaments";
import {
  MCP_REGISTRY,
  SHORT_ADDR,
  type Vault,
  type Agent,
  type Mcp,
} from "./data";

interface User {
  name: string;
  email: string;
  address: string;
  joined: string;
  provider: string;
}

export const Profile = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, setShowLogin } = useAuth();
  const onNavigate = (r: string) => router.push(r === "home" ? "/" : `/${r}`);

  const bindId = searchParams.get("bind");
  const [bindMcp, setBindMcp] = useState<Mcp | null>(
    bindId ? (MCP_REGISTRY.find((m) => m.id === bindId) ?? null) : null
  );
  const onClearBind = () => {
    setBindMcp(null);
    router.replace("/profile");
  };

  const [tab, setTab] = useState(bindMcp ? "agents" : "overview");
  const [creatingVault, setCreatingVault] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(!!bindMcp);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);
  const [vaultsError, setVaultsError] = useState<string | null>(null);
  const [editingVaultId, setEditingVaultId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const reloadAgents = useCallback(async (signal?: AbortSignal) => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const res = await fetch("/api/agents", { signal });
      const payload = (await res.json().catch(() => null)) as
        | {
            agents?: Array<{
              id: string;
              name: string;
              is_active?: boolean;
              created_at?: string;
            }>;
            error?: string;
          }
        | null;
      if (!res.ok) {
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
      const upstreamAgents = payload?.agents ?? [];

      const vaultsRes = await fetch("/api/vaults", { signal });
      const vaultsPayload = (await vaultsRes.json().catch(() => null)) as
        | { vaults?: Vault[]; error?: string }
        | null;
      const knownVaults = vaultsRes.ok ? vaultsPayload?.vaults ?? [] : [];

      type Grant = {
        id: string;
        vaultId: string;
        principalType: string;
        principalId: string;
        secretPathPattern: string;
      };
      const grantLists = await Promise.all(
        knownVaults.map(async (v) => {
          const gres = await fetch(`/api/vaults/${v.id}/key-grants`, { signal });
          if (!gres.ok) return [] as Grant[];
          const gpayload = (await gres.json().catch(() => null)) as
            | { grants?: Grant[] }
            | null;
          return gpayload?.grants ?? [];
        }),
      );
      const agentToGrant = new Map<string, Grant & { vaultName: string }>();
      grantLists.forEach((grants, i) => {
        const vaultName = knownVaults[i]?.name ?? "";
        for (const g of grants) {
          if (g.principalType !== "agent") continue;
          if (!agentToGrant.has(g.principalId)) {
            agentToGrant.set(g.principalId, { ...g, vaultName });
          }
        }
      });

      const merged: Agent[] = upstreamAgents.map((a) => {
        const g = agentToGrant.get(a.id);
        return {
          id: a.id,
          name: a.name,
          vault: g?.vaultName ?? "",
          vaultId: g?.vaultId,
          grantId: g?.id,
          keyPath: g?.secretPathPattern,
          mcps: [],
          status: a.is_active === false ? "paused" : "active",
          runs: 0,
          lastRun: a.created_at ? "—" : "never",
        };
      });

      if (!signal?.aborted) setAgents(merged);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAgentsError(
        err instanceof Error ? err.message : "Failed to load agents",
      );
    } finally {
      if (!signal?.aborted) setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const ac = new AbortController();
    const run = async () => {
      setVaultsLoading(true);
      setVaultsError(null);
      try {
        const res = await fetch("/api/vaults", { signal: ac.signal });
        const payload = (await res.json().catch(() => null)) as
          | { vaults?: Vault[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Request failed (${res.status})`);
        }
        setVaults(payload?.vaults ?? []);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setVaultsError(
          err instanceof Error ? err.message : "Failed to load vaults",
        );
      } finally {
        if (!ac.signal.aborted) setVaultsLoading(false);
      }
    };
    void Promise.resolve().then(run);
    void Promise.resolve().then(() => reloadAgents(ac.signal));
    return () => ac.abort();
  }, [user, reloadAgents]);

  const tabs = [
    { id: "overview", l: "Overview" },
    { id: "vaults", l: "Vaults & Keys" },
    { id: "agents", l: "Agents" },
    { id: "settings", l: "Settings" },
  ];

  if (!user) {
    return (
      <main style={{ padding: "80px 32px", textAlign: "center" }}>
        <p className="poetic" style={{ fontSize: 22, color: "var(--ink-soft)" }}>
          Sign in to access your profile.
        </p>
        <button
          onClick={() => setShowLogin(true)}
          style={{
            marginTop: 24,
            padding: "12px 28px",
            background: "var(--ink)",
            color: "var(--parchment)",
            border: "none",
            fontFamily: "var(--font-ui)",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Sign in →
        </button>
      </main>
    );
  }

  return (
    <main style={{ padding: "40px 32px 80px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* profile header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 24,
            alignItems: "center",
            padding: 24,
            background: "var(--ink)",
            color: "var(--parchment)",
            boxShadow: "5px 5px 0 var(--brass)",
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              background: "var(--brass)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink)",
              border: "3px solid var(--brass-bright)",
            }}
          >
            <OrlojMark size={64} />
          </div>
          <div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div className="display" style={{ fontSize: 28 }}>
                {user.name}
              </div>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                color: "var(--brass-bright)",
                marginTop: 4,
              }}
            >
              {user.address ? SHORT_ADDR(user.address) : ""} · joined{" "}
              {user.joined}
            </div>
            <div
              style={{
                display: "flex",
                gap: 24,
                marginTop: 14,
                fontSize: 13,
                color: "rgba(241,233,212,0.7)",
              }}
            >
              <span>{vaults.length} vaults</span>
              <span>·</span>
              <span>{agents.length} agents</span>
              <span>·</span>
              <span>
                {agents.reduce((a, b) => a + b.runs, 0)} tool calls this month
              </span>
            </div>
          </div>
        </div>

        {/* tabs */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid var(--line)",
            marginTop: 24,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="smallcaps"
              style={{
                padding: "14px 22px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "var(--font-ui)",
                color: tab === t.id ? "var(--ink)" : "var(--ink-soft)",
                borderBottom: `2px solid ${
                  tab === t.id ? "var(--brass)" : "transparent"
                }`,
                fontWeight: tab === t.id ? 600 : 400,
              }}
            >
              {t.l}
            </button>
          ))}
        </div>

        {/* binding banner */}
        {bindMcp && tab === "agents" && (
          <div
            style={{
              marginTop: 18,
              padding: 16,
              background: "rgba(184,137,58,0.18)",
              border: "1.5px solid var(--brass)",
              display: "flex",
              gap: 14,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 22, color: "var(--brass-deep)" }}>🔗</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Binding &ldquo;{bindMcp.name}&rdquo; to a new agent…
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-soft)",
                  marginTop: 2,
                }}
              >
                Select a vault below or close to bind to an existing agent.
              </div>
            </div>
            <Btn size="sm" kind="ghost" onClick={onClearBind}>
              Cancel binding
            </Btn>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          {tab === "overview" && (
            <Overview
              user={user ?? undefined}
              vaults={vaults}
              agents={agents}
              onNavigate={onNavigate}
            />
          )}
          {tab === "vaults" && (
            <Vaults
              vaults={vaults}
              setVaults={setVaults}
              creating={creatingVault}
              setCreating={setCreatingVault}
              loading={vaultsLoading}
              error={vaultsError}
              editingVaultId={editingVaultId}
              setEditingVaultId={setEditingVaultId}
            />
          )}
          {tab === "agents" && (
            <Agents
              agents={agents}
              vaults={vaults}
              creating={creatingAgent}
              setCreating={setCreatingAgent}
              bindMcp={bindMcp}
              onClearBind={onClearBind}
              loading={agentsLoading}
              error={agentsError}
              reload={reloadAgents}
            />
          )}
          {tab === "settings" && (
            <Settings user={user!} />
          )}
        </div>
      </div>
    </main>
  );
};

const Overview = ({
  vaults,
  agents,
  onNavigate,
}: {
  user?: User;
  vaults: Vault[];
  agents: Agent[];
  onNavigate: (r: string) => void;
}) => (
  <div>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 16,
      }}
    >
      {[
        {
          l: "tool calls / month",
          v: "1,047",
          d: "+18% vs prior",
          tone: "verdigris",
        },
        {
          l: "active vaults",
          v: vaults.length,
          d: "all under policy",
          tone: "brass",
        },
        {
          l: "agents online",
          v: agents.filter((a) => a.status === "active").length,
          d: `${agents.length} total`,
          tone: "blue",
        },
        { l: "mcps bound", v: "7", d: "across 4 chains", tone: "wine" },
      ].map((s, i) => {
        const accent =
          s.tone === "verdigris"
            ? "var(--verdigris)"
            : s.tone === "brass"
            ? "var(--brass)"
            : s.tone === "blue"
            ? "var(--stained-blue)"
            : "var(--wine)";
        return (
          <div
            key={i}
            style={{
              padding: 20,
              background: "rgba(241,233,212,0.5)",
              border: "1px solid var(--line)",
              borderTop: `3px solid ${accent}`,
            }}
          >
            <div
              className="smallcaps"
              style={{ fontSize: 11, color: "var(--ink-soft)" }}
            >
              {s.l}
            </div>
            <div
              className="display"
              style={{
                fontSize: 36,
                color: "var(--ink)",
                marginTop: 4,
                lineHeight: 1,
              }}
            >
              {s.v}
            </div>
            <div
              style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}
            >
              {s.d}
            </div>
          </div>
        );
      })}
    </div>

    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 24,
        marginTop: 28,
      }}
    >
      <div>
        <h3 className="display" style={{ fontSize: 20, margin: 0 }}>
          Recent activity
        </h3>
        <ActivityFeed compact />
      </div>
      <div>
        <h3 className="display" style={{ fontSize: 20, margin: 0 }}>
          Suggested MCPs
        </h3>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {MCP_REGISTRY.slice(0, 3).map((m) => (
            <div
              key={m.id}
              onClick={() => onNavigate("explore")}
              style={{
                padding: 12,
                display: "flex",
                gap: 10,
                alignItems: "center",
                background: "rgba(241,233,212,0.5)",
                border: "1px solid var(--line)",
                cursor: "pointer",
              }}
            >
              <Identicon seed={m.id} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {m.name}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                  {m.tags.slice(0, 2).join(" · ")}
                </div>
              </div>
              <span style={{ color: "var(--brass-deep)" }}>→</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

const Vaults = ({
  vaults,
  setVaults,
  creating,
  setCreating,
  loading,
  error,
  editingVaultId,
  setEditingVaultId,
}: {
  vaults: Vault[];
  setVaults: React.Dispatch<React.SetStateAction<Vault[]>>;
  creating: boolean;
  setCreating: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  editingVaultId: string | null;
  setEditingVaultId: (id: string | null) => void;
}) => {
  const editingVault = editingVaultId
    ? (vaults.find((v) => v.id === editingVaultId) ?? null)
    : null;
  const onVaultDeleted = useCallback(
    (id: string) => {
      setVaults((vs) => vs.filter((x) => x.id !== id));
      setEditingVaultId(null);
    },
    [setVaults, setEditingVaultId],
  );
  const onKeyCountChange = useCallback(
    (id: string, count: number) => {
      setVaults((vs) =>
        vs.map((x) => (x.id === id ? { ...x, keyCount: count } : x)),
      );
    },
    [setVaults],
  );
  return (
  <div>
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: 18,
      }}
    >
      <div>
        <h2 className="display" style={{ fontSize: 28, margin: 0 }}>
          Vaults
        </h2>
        <p
          className="poetic"
          style={{
            fontSize: 17,
            color: "var(--ink-soft)",
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          Custody routed through KMS providers. Keys never leave the enclave.
        </p>
      </div>
      <Btn kind="primary" onClick={() => setCreating(true)}>
        + Create vault
      </Btn>
    </div>

    {creating && (
      <CreateVault
        onCancel={() => setCreating(false)}
        onCreate={(vault) => {
          setVaults([...vaults, vault]);
          setCreating(false);
        }}
      />
    )}

    {editingVault && (
      <EditVault
        vault={editingVault}
        onClose={() => setEditingVaultId(null)}
        onDeleted={onVaultDeleted}
        onKeyCountChange={onKeyCountChange}
      />
    )}

    {error && (
      <div
        style={{
          padding: "12px 14px",
          background: "rgba(140,30,40,0.08)",
          border: "1px solid var(--wine)",
          color: "var(--wine)",
          fontSize: 13,
          marginBottom: 18,
        }}
      >
        {error}
      </div>
    )}

    {loading && vaults.length === 0 && !error ? (
      <div
        className="poetic"
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--ink-soft)",
          fontSize: 16,
        }}
      >
        Loading vaults…
      </div>
    ) : !loading && vaults.length === 0 && !error ? (
      <div
        className="poetic"
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--ink-soft)",
          fontSize: 16,
        }}
      >
        No vaults yet — create one to get started.
      </div>
    ) : (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: 18,
        }}
      >
        {vaults.map((v) => (
          <div
            key={v.id}
            style={{
              position: "relative",
              padding: 20,
              background: "rgba(241,233,212,0.55)",
              border: "1px solid var(--line)",
              borderLeft: "4px solid var(--brass)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="display" style={{ fontSize: 18 }}>
                  {v.name}
                </div>
                {v.description && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--ink-soft)",
                      marginTop: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {v.description}
                  </div>
                )}
              </div>
              <Pill tone="verdigris">● secured</Pill>
            </div>
            <div
              className="mono"
              style={{
                marginTop: 14,
                fontSize: 11,
                color: "var(--ink-soft)",
                wordBreak: "break-all",
              }}
            >
              {v.id}
            </div>
            <div
              className="smallcaps"
              style={{
                marginTop: 14,
                fontSize: 10,
                color: "var(--ink-soft)",
              }}
            >
              {v.keyCount} {v.keyCount === 1 ? "key" : "keys"}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <Btn
                size="sm"
                kind="ghost"
                onClick={() => setEditingVaultId(v.id)}
              >
                Edit
              </Btn>
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
  );
};

const CreateVault = ({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (vault: Vault) => void;
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/vaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      if (res.status === 401) {
        setError("Your session has expired. Please sign in again.");
        return;
      }
      const payload = (await res.json().catch(() => null)) as
        | { vault?: Vault; error?: string }
        | null;
      if (!res.ok) {
        setError(payload?.error ?? "Failed to create vault.");
        return;
      }
      if (!payload?.vault) {
        setError("Unexpected response from server.");
        return;
      }
      onCreate(payload.vault);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        padding: 24,
        marginBottom: 20,
        background: "var(--parchment-2)",
        border: "2px solid var(--brass)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 18,
        }}
      >
        <GearIcon size={20} />
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>
          New vault
        </h3>
      </div>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Daily Operations"
          maxLength={80}
          disabled={submitting}
        />
      </Field>
      <Field label="Description" style={{ marginTop: 16 }}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this vault for?"
          maxLength={500}
          disabled={submitting}
          rows={3}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "rgba(255,255,255,0.45)",
            border: "1px solid var(--line)",
            fontFamily: "var(--font-ui)",
            fontSize: 14,
            color: "var(--ink)",
            outline: "none",
            borderRadius: 0,
            resize: "vertical",
          }}
        />
      </Field>
      {error && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 22,
          justifyContent: "flex-end",
        }}
      >
        <Btn kind="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Btn>
        <Btn
          kind="primary"
          disabled={!name.trim() || submitting}
          onClick={submit}
        >
          {submitting ? "Creating…" : "Generate vault"}
        </Btn>
      </div>
    </div>
  );
};

type VaultKey = {
  id: string;
  key: string;
  type: string;
  version: number;
  createdAt: string;
};

type AddMode = null | "menu" | "import";

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const CopyIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5" y="5" width="9" height="9" rx="1" />
    <path d="M3 11V3a1 1 0 0 1 1-1h7" />
  </svg>
);

const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 8.5l3 3L13 4.5" />
  </svg>
);

const QrIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="2" width="4.5" height="4.5" />
    <rect x="9.5" y="2" width="4.5" height="4.5" />
    <rect x="2" y="9.5" width="4.5" height="4.5" />
    <path d="M9.5 9.5h2.25v2.25M14 9.5v4.5M9.5 14h2.25" />
  </svg>
);

const XIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
  >
    <line x1="4" y1="4" x2="12" y2="12" />
    <line x1="12" y1="4" x2="4" y2="12" />
  </svg>
);

const KeyIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="M7.7 9.3 13.5 3.5" />
    <path d="M11.5 5.5 13 7" />
    <path d="M10 7l1.25 1.25" />
  </svg>
);

const IconBtn = ({
  children,
  onClick,
  disabled,
  label,
  tone = "ink",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  tone?: "ink" | "wine";
}) => {
  const base = tone === "wine" ? "var(--wine)" : "var(--ink)";
  const hoverBg =
    tone === "wine" ? "rgba(140,30,40,0.10)" : "rgba(184,137,58,0.18)";
  const hoverBorder = tone === "wine" ? "var(--wine)" : "var(--brass)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        width: 32,
        height: 32,
        display: "grid",
        placeItems: "center",
        background: "rgba(255,255,255,0.6)",
        border: "1px solid var(--line)",
        cursor: disabled ? "not-allowed" : "pointer",
        color: base,
        opacity: disabled ? 0.4 : 1,
        transition:
          "background 0.18s ease, border-color 0.18s ease, color 0.18s ease",
        flexShrink: 0,
        padding: 0,
        borderRadius: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.borderColor = hoverBorder;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.6)";
        e.currentTarget.style.borderColor = "var(--line)";
      }}
    >
      {children}
    </button>
  );
};

const HoldDeleteBtn = ({
  onConfirm,
  disabled,
  label = "Hold to delete",
  duration = 1200,
}: {
  onConfirm: () => void;
  disabled?: boolean;
  label?: string;
  duration?: number;
}) => {
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const start = () => {
    if (disabled || timerRef.current) return;
    setHolding(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHolding(false);
      onConfirm();
    }, duration);
  };

  const cancel = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
  };

  return (
    <button
      type="button"
      onMouseDown={start}
      onMouseUp={cancel}
      onMouseLeave={cancel}
      onTouchStart={(e) => {
        e.preventDefault();
        start();
      }}
      onTouchEnd={cancel}
      onTouchCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        position: "relative",
        width: 32,
        height: 32,
        background: "rgba(255,255,255,0.6)",
        border: "1px solid var(--line)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        padding: 0,
        borderRadius: 0,
        overflow: "hidden",
        userSelect: "none",
        touchAction: "none",
        transition: "border-color 0.18s ease",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.border = "1px solid var(--wine)";
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--wine)",
          transformOrigin: "left center",
          transform: holding ? "scaleX(1)" : "scaleX(0)",
          transition: holding
            ? `transform ${duration}ms linear`
            : "transform 0.15s ease-out",
          pointerEvents: "none",
        }}
      />
      <span
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: holding ? "var(--parchment)" : "var(--wine)",
          transition: "color 0.18s ease",
        }}
      >
        <XIcon />
      </span>
    </button>
  );
};

const PaymentQrModal = ({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) => {
  const uri = `ethereum:${address}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(uri)}`;
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,24,16,0.65)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--parchment-2)",
          border: "2px solid var(--brass)",
          padding: 28,
          textAlign: "center",
          maxWidth: 320,
          boxShadow: "5px 5px 0 var(--brass)",
        }}
      >
        <h3
          className="display"
          style={{ fontSize: 18, margin: 0, marginBottom: 4 }}
        >
          Payment QR
        </h3>
        <div
          className="poetic"
          style={{
            fontSize: 13,
            color: "var(--ink-soft)",
            marginBottom: 16,
          }}
        >
          Scan to send to this address.
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrSrc}
          alt={`Payment QR for ${address}`}
          width={240}
          height={240}
          style={{
            display: "block",
            margin: "0 auto",
            background: "var(--parchment)",
            border: "1px solid var(--line)",
          }}
        />
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-soft)",
            marginTop: 14,
            wordBreak: "break-all",
          }}
        >
          {address}
        </div>
        <div style={{ marginTop: 18 }}>
          <Btn kind="ghost" size="sm" onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    </div>
  );
};

const REDACTED =
  "0x" + "•".repeat(64);

const BackupKeyModal = ({
  vaultId,
  vaultKey,
  onClose,
}: {
  vaultId: string;
  vaultKey: VaultKey;
  onClose: () => void;
}) => {
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const segments = vaultKey.key
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const res = await fetch(`/api/vaults/${vaultId}/secrets/${segments}`);
      const payload = (await res.json().catch(() => null)) as
        | { secret?: { value?: string }; error?: string }
        | null;
      if (!res.ok || !payload?.secret?.value) {
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
      setValue(payload.secret.value);
      setRevealed(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load key");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,24,16,0.65)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--parchment-2)",
          border: "2px solid var(--brass)",
          padding: 28,
          maxWidth: 520,
          width: "calc(100vw - 48px)",
          boxShadow: "5px 5px 0 var(--brass)",
        }}
      >
        <h3
          className="display"
          style={{ fontSize: 18, margin: 0, marginBottom: 4 }}
        >
          Backup private key
        </h3>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--ink-soft)",
            marginBottom: 16,
            wordBreak: "break-all",
          }}
        >
          {vaultKey.key}
        </div>

        <div
          style={{
            padding: "12px 14px",
            background: "rgba(140,30,40,0.10)",
            border: "1px solid var(--wine)",
            borderLeft: "4px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          <div
            className="smallcaps"
            style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}
          >
            ⚠ warning
          </div>
          Anyone with this private key has full control of this wallet. Never
          share it. Store the backup in a secure password manager or hardware
          wallet, and clear it from your clipboard when done.
        </div>

        <div
          className="smallcaps"
          style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}
        >
          private key
        </div>
        <div
          className="mono"
          style={{
            padding: "12px 14px",
            background: "var(--ink)",
            color: revealed && value ? "var(--brass-bright)" : "var(--ink-soft)",
            fontSize: 12,
            wordBreak: "break-all",
            userSelect: revealed ? "all" : "none",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
          }}
        >
          {revealed && value ? value : REDACTED}
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              background: "rgba(140,30,40,0.08)",
              border: "1px solid var(--wine)",
              color: "var(--wine)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          {!revealed ? (
            <>
              <Btn kind="ghost" size="sm" onClick={onClose} disabled={loading}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                size="sm"
                onClick={reveal}
                disabled={loading}
                style={{
                  background: "var(--wine)",
                  border: "1px solid var(--wine)",
                  color: "var(--parchment)",
                }}
              >
                {loading ? "Loading…" : "I understand, reveal key"}
              </Btn>
            </>
          ) : (
            <>
              <Btn kind="ghost" size="sm" onClick={copy}>
                {copied ? "Copied!" : "Copy key"}
              </Btn>
              <Btn kind="primary" size="sm" onClick={onClose}>
                Done
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const EditVault = ({
  vault,
  onClose,
  onDeleted,
  onKeyCountChange,
}: {
  vault: Vault;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onKeyCountChange: (id: string, count: number) => void;
}) => {
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [addMode, setAddMode] = useState<AddMode>(null);
  const [importValue, setImportValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [qrAddress, setQrAddress] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [backupKey, setBackupKey] = useState<VaultKey | null>(null);

  const copyAddress = async (addr: string) => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(addr);
      }
      setCopiedKey(addr);
      setTimeout(() => {
        setCopiedKey((cur) => (cur === addr ? null : cur));
      }, 1500);
    } catch {
      // clipboard unavailable — silently no-op
    }
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = adding || deleting || !!removingKey;

  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      setKeysLoading(true);
      setKeysError(null);
      try {
        const res = await fetch(`/api/vaults/${vault.id}/secrets`, {
          signal: ac.signal,
        });
        const payload = (await res.json().catch(() => null)) as
          | { secrets?: VaultKey[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Request failed (${res.status})`);
        }
        const next = payload?.secrets ?? [];
        setKeys(next);
        onKeyCountChange(vault.id, next.length);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setKeysError(
          err instanceof Error ? err.message : "Failed to load keys",
        );
      } finally {
        if (!ac.signal.aborted) setKeysLoading(false);
      }
    };
    void Promise.resolve().then(run);
    return () => ac.abort();
  }, [vault.id, onKeyCountChange]);

  const submitSecret = async (privateKey: Hex, address: string) => {
    const res = await fetch(`/api/vaults/${vault.id}/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: address,
        value: privateKey,
        type: "private_key",
      }),
    });
    if (res.status === 401) {
      throw new Error("Your session has expired. Please sign in again.");
    }
    const payload = (await res.json().catch(() => null)) as
      | { secret?: VaultKey; error?: string }
      | null;
    if (!res.ok || !payload?.secret) {
      throw new Error(payload?.error ?? `Request failed (${res.status})`);
    }
    return payload.secret;
  };

  const createWallet = async () => {
    if (busy) return;
    setAdding(true);
    setAddError(null);
    try {
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const secret = await submitSecret(privateKey, account.address);
      setKeys((prev) => [...prev, secret]);
      onKeyCountChange(vault.id, keys.length + 1);
      setAddMode(null);
    } catch (err: unknown) {
      setAddError(
        err instanceof Error ? err.message : "Failed to create wallet",
      );
    } finally {
      setAdding(false);
    }
  };

  const importKey = async () => {
    if (busy) return;
    const trimmed = importValue.trim();
    if (!PRIVATE_KEY_RE.test(trimmed)) {
      setAddError("Private key must be 0x-prefixed and 64 hex characters.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const privateKey = trimmed as Hex;
      const account = privateKeyToAccount(privateKey);
      const secret = await submitSecret(privateKey, account.address);
      setKeys((prev) => [...prev, secret]);
      onKeyCountChange(vault.id, keys.length + 1);
      setImportValue("");
      setAddMode(null);
    } catch (err: unknown) {
      setAddError(
        err instanceof Error ? err.message : "Failed to import private key",
      );
    } finally {
      setAdding(false);
    }
  };

  const removeKey = async (k: VaultKey) => {
    if (busy) return;
    setRemovingKey(k.key);
    setKeysError(null);
    try {
      const segments = k.key.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(
        `/api/vaults/${vault.id}/secrets/${segments}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
      setKeys((prev) => prev.filter((x) => x.id !== k.id));
      onKeyCountChange(vault.id, keys.length - 1);
    } catch (err: unknown) {
      setKeysError(
        err instanceof Error ? err.message : "Failed to remove key",
      );
    } finally {
      setRemovingKey(null);
    }
  };

  const closeAddMenu = () => {
    setAddMode(null);
    setImportValue("");
    setAddError(null);
  };

  const deleteVault = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/vaults/${vault.id}`, { method: "DELETE" });
      if (res.status === 401) {
        setError("Your session has expired. Please sign in again.");
        return;
      }
      if (!res.ok && res.status !== 204) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? `Request failed (${res.status})`);
        return;
      }
      onDeleted(vault.id);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        padding: 24,
        marginBottom: 20,
        background: "var(--parchment-2)",
        border: "2px solid var(--brass)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <GearIcon size={20} />
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>
          Edit vault
        </h3>
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--ink-soft)",
          marginBottom: 18,
        }}
      >
        {vault.name}
      </div>

      <div
        className="smallcaps"
        style={{
          fontSize: 11,
          color: "var(--ink-soft)",
          marginBottom: 8,
        }}
      >
        keys ({keys.length})
      </div>
      {keysLoading && keys.length === 0 ? (
        <div
          style={{
            padding: "14px 12px",
            background: "rgba(255,255,255,0.4)",
            border: "1px dashed var(--line)",
            color: "var(--ink-soft)",
            fontSize: 13,
            fontStyle: "italic",
            marginBottom: 12,
          }}
        >
          Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <div
          style={{
            padding: "14px 12px",
            background: "rgba(255,255,255,0.4)",
            border: "1px dashed var(--line)",
            color: "var(--ink-soft)",
            fontSize: 13,
            fontStyle: "italic",
            marginBottom: 12,
          }}
        >
          No keys in this vault yet.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 12,
          }}
        >
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                background: "rgba(255,255,255,0.4)",
                border: "1px solid var(--line)",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {k.key}
              </span>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <IconBtn
                  label={copiedKey === k.key ? "Copied" : "Copy address"}
                  onClick={() => void copyAddress(k.key)}
                  disabled={busy}
                >
                  {copiedKey === k.key ? <CheckIcon /> : <CopyIcon />}
                </IconBtn>
                <IconBtn
                  label="Show payment QR"
                  onClick={() => setQrAddress(k.key)}
                  disabled={busy}
                >
                  <QrIcon />
                </IconBtn>
                <IconBtn
                  label="Backup private key"
                  onClick={() => setBackupKey(k)}
                  disabled={busy}
                >
                  <KeyIcon />
                </IconBtn>
                <HoldDeleteBtn
                  label={
                    removingKey === k.key
                      ? "Removing…"
                      : "Hold to delete key"
                  }
                  onConfirm={() => void removeKey(k)}
                  disabled={busy}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {keysError && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {keysError}
        </div>
      )}

      {addMode === null && (
        <Btn
          kind="ghost"
          onClick={() => setAddMode("menu")}
          disabled={busy}
        >
          + Add key
        </Btn>
      )}

      {addMode === "menu" && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: 12,
            background: "rgba(255,255,255,0.45)",
            border: "1px solid var(--line)",
          }}
        >
          <Btn
            kind="primary"
            size="sm"
            onClick={createWallet}
            disabled={busy}
          >
            {adding ? "Creating…" : "Create new wallet"}
          </Btn>
          <Btn
            kind="ghost"
            size="sm"
            onClick={() => {
              setAddMode("import");
              setAddError(null);
            }}
            disabled={busy}
          >
            Import private key
          </Btn>
          <Btn
            kind="ghost"
            size="sm"
            onClick={closeAddMenu}
            disabled={busy}
          >
            Cancel
          </Btn>
        </div>
      )}

      {addMode === "import" && (
        <div
          style={{
            padding: 12,
            background: "rgba(255,255,255,0.45)",
            border: "1px solid var(--line)",
          }}
        >
          <Field label="Private key (0x-prefixed, 64 hex chars)">
            <Input
              value={importValue}
              onChange={(e) => setImportValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void importKey();
                }
              }}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              type="password"
              disabled={busy}
            />
          </Field>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 12,
              justifyContent: "flex-end",
            }}
          >
            <Btn kind="ghost" size="sm" onClick={closeAddMenu} disabled={busy}>
              Cancel
            </Btn>
            <Btn
              kind="primary"
              size="sm"
              onClick={importKey}
              disabled={!importValue.trim() || busy}
            >
              {adding ? "Adding…" : "Add"}
            </Btn>
          </div>
        </div>
      )}

      {addError && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {addError}
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 22,
          paddingTop: 18,
          borderTop: "1px solid var(--line)",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Btn kind="ghost" onClick={onClose} disabled={deleting}>
          Close
        </Btn>
        {confirmingDelete ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              style={{
                fontSize: 13,
                color: "var(--ink-soft)",
                marginRight: 4,
              }}
            >
              Delete this vault?
            </span>
            <Btn
              size="sm"
              kind="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              kind="primary"
              onClick={deleteVault}
              disabled={deleting}
              style={{
                background: "var(--wine)",
                border: "1px solid var(--wine)",
                color: "var(--parchment)",
              }}
            >
              {deleting ? "Deleting…" : "Yes, delete"}
            </Btn>
          </div>
        ) : (
          <Btn
            kind="ghost"
            onClick={() => setConfirmingDelete(true)}
            disabled={deleting}
            style={{
              color: "var(--wine)",
              border: "1px solid var(--wine)",
            }}
          >
            Delete vault
          </Btn>
        )}
      </div>
      {qrAddress && (
        <PaymentQrModal
          address={qrAddress}
          onClose={() => setQrAddress(null)}
        />
      )}
      {backupKey && (
        <BackupKeyModal
          vaultId={vault.id}
          vaultKey={backupKey}
          onClose={() => setBackupKey(null)}
        />
      )}
    </div>
  );
};

const Agents = ({
  agents,
  vaults,
  creating,
  setCreating,
  bindMcp,
  onClearBind,
  loading,
  error,
  reload,
}: {
  agents: Agent[];
  vaults: Vault[];
  creating: boolean;
  setCreating: (v: boolean) => void;
  bindMcp: Mcp | null;
  onClearBind: () => void;
  loading: boolean;
  error: string | null;
  reload: (signal?: AbortSignal) => Promise<void>;
}) => {
  const [revealing, setRevealing] = useState<Agent | null>(null);
  const [changingKey, setChangingKey] = useState<Agent | null>(null);
  const [newApiKey, setNewApiKey] = useState<{
    agentName: string;
    apiKey: string;
  } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleDelete = async (a: Agent) => {
    if (
      !window.confirm(
        `Delete agent "${a.name}"? This revokes all key access and cannot be undone.`,
      )
    ) {
      return;
    }
    setRemovingId(a.id);
    try {
      if (a.vaultId && a.grantId) {
        await fetch(`/api/vaults/${a.vaultId}/key-grants/${a.grantId}`, {
          method: "DELETE",
        });
      }
      const res = await fetch(`/api/agents/${a.id}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 18,
        }}
      >
        <div>
          <h2 className="display" style={{ fontSize: 28, margin: 0 }}>
            Agents
          </h2>
          <p
            className="poetic"
            style={{
              fontSize: 17,
              color: "var(--ink-soft)",
              marginTop: 4,
              marginBottom: 0,
            }}
          >
            Each agent rings a different bell. Bind MCPs and set them off.
          </p>
        </div>
        <Btn kind="primary" onClick={() => setCreating(true)}>
          + Register agent
        </Btn>
      </div>

      {creating && (
        <CreateAgent
          vaults={vaults}
          bindMcp={bindMcp}
          onCancel={() => {
            setCreating(false);
            onClearBind();
          }}
          onCreated={async (apiKey, name) => {
            setCreating(false);
            onClearBind();
            if (apiKey) setNewApiKey({ agentName: name, apiKey });
            await reload();
          }}
        />
      )}

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading && agents.length === 0 ? (
        <div style={{ padding: 24, color: "var(--ink-soft)" }}>Loading agents…</div>
      ) : agents.length === 0 ? (
        <div
          style={{
            padding: 28,
            background: "rgba(241,233,212,0.5)",
            border: "1px dashed var(--line)",
            color: "var(--ink-soft)",
            textAlign: "center",
          }}
        >
          No agents yet. Register one to grant it signing access to a key.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {agents.map((a) => (
            <div
              key={a.id}
              style={{
                padding: 18,
                background: "rgba(241,233,212,0.55)",
                border: "1px solid var(--line)",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 18,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  background: "var(--ink)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--brass)",
                }}
              >
                <GearIcon
                  size={32}
                  color="var(--brass-bright)"
                  spinning={a.status === "active"}
                />
              </div>
              <div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div className="display" style={{ fontSize: 18 }}>
                    {a.name}
                  </div>
                  <Pill
                    tone={
                      a.status === "active"
                        ? "verdigris"
                        : a.status === "paused"
                        ? "ink"
                        : "wine"
                    }
                  >
                    {a.status === "active"
                      ? "● active"
                      : a.status === "paused"
                      ? "⏸ paused"
                      : "⚠ review"}
                  </Pill>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-soft)",
                    marginTop: 4,
                  }}
                >
                  vault:{" "}
                  <span style={{ color: "var(--ink)" }}>
                    {a.vault || "— not granted —"}
                  </span>
                </div>
                {a.keyPath ? (
                  <div
                    className="mono"
                    style={{
                      fontSize: 12,
                      color: "var(--ink-soft)",
                      marginTop: 4,
                      wordBreak: "break-all",
                    }}
                  >
                    address:{" "}
                    <span style={{ color: "var(--ink)" }}>{a.keyPath}</span>
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--wine)",
                      marginTop: 4,
                    }}
                  >
                    No key granted yet.
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                <Btn
                  size="sm"
                  kind="ghost"
                  onClick={() => setRevealing(a)}
                >
                  Reveal API key
                </Btn>
                <Btn
                  size="sm"
                  kind="ghost"
                  onClick={() => setChangingKey(a)}
                >
                  {a.keyPath ? "Change key" : "Grant key"}
                </Btn>
                <Btn
                  size="sm"
                  kind="ghost"
                  disabled={removingId === a.id}
                  onClick={() => handleDelete(a)}
                  style={{ color: "var(--wine)" }}
                >
                  {removingId === a.id ? "Deleting…" : "Delete"}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {revealing && (
        <RevealAgentApiKeyModal
          agentId={revealing.id}
          agentName={revealing.name}
          onClose={() => setRevealing(null)}
        />
      )}

      {changingKey && (
        <ChangeAgentKeyModal
          agent={changingKey}
          vaults={vaults}
          onClose={() => setChangingKey(null)}
          onChanged={async () => {
            setChangingKey(null);
            await reload();
          }}
        />
      )}

      {newApiKey && (
        <NewAgentApiKeyModal
          agentName={newApiKey.agentName}
          apiKey={newApiKey.apiKey}
          onClose={() => setNewApiKey(null)}
        />
      )}
    </div>
  );
};

const CreateAgent = ({
  vaults,
  bindMcp,
  onCancel,
  onCreated,
}: {
  vaults: Vault[];
  bindMcp: Mcp | null;
  onCancel: () => void;
  onCreated: (apiKey: string | null, name: string) => Promise<void> | void;
}) => {
  const [name, setName] = useState("");
  const [vaultId, setVaultId] = useState(vaults[0]?.id ?? "");
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      if (!vaultId) {
        setKeys([]);
        setKeyPath("");
        return;
      }
      setKeysLoading(true);
      setKeysError(null);
      try {
        const res = await fetch(`/api/vaults/${vaultId}/secrets`, {
          signal: ac.signal,
        });
        const payload = (await res.json().catch(() => null)) as
          | { secrets?: VaultKey[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Request failed (${res.status})`);
        }
        const list = payload?.secrets ?? [];
        setKeys(list);
        setKeyPath(list[0]?.key ?? "");
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setKeysError(
          err instanceof Error ? err.message : "Failed to load keys",
        );
      } finally {
        if (!ac.signal.aborted) setKeysLoading(false);
      }
    };
    void Promise.resolve().then(run);
    return () => ac.abort();
  }, [vaultId]);

  const submit = async () => {
    if (submitting) return;
    if (!name.trim() || !vaultId || !keyPath) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const createPayload = (await createRes.json().catch(() => null)) as
        | { agent?: { id: string }; api_key?: string; error?: string }
        | null;
      if (!createRes.ok || !createPayload?.agent?.id) {
        throw new Error(
          createPayload?.error ?? `Request failed (${createRes.status})`,
        );
      }
      const agentId = createPayload.agent.id;
      const apiKey = createPayload.api_key ?? null;

      const grantRes = await fetch(`/api/vaults/${vaultId}/key-grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          secretPathPattern: keyPath,
          permissions: ["read"],
        }),
      });
      if (!grantRes.ok) {
        const grantPayload = (await grantRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        await fetch(`/api/agents/${agentId}`, { method: "DELETE" }).catch(
          () => {},
        );
        throw new Error(
          grantPayload?.error ?? `Failed to grant key (${grantRes.status})`,
        );
      }

      await onCreated(apiKey, name.trim());
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create agent",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    !!name.trim() && !!vaultId && !!keyPath && !submitting && !keysLoading;

  return (
    <div
      style={{
        padding: 24,
        marginBottom: 20,
        background: "var(--parchment-2)",
        border: "2px solid var(--brass)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 18,
        }}
      >
        <GearIcon size={20} />
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>
          {bindMcp ? `Bind "${bindMcp.name}" to a new agent` : "New agent"}
        </h3>
      </div>
      <div
        style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}
      >
        <Field label="Agent name" hint="A name your team will recognize.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Karel — Yield Steward"
          />
        </Field>
        <Field
          label="Operating vault"
          hint={
            vaults.length === 0 ? "Create a vault first to grant a key." : undefined
          }
        >
          <Select
            value={vaults.find((v) => v.id === vaultId)?.name ?? ""}
            onChange={(name) => {
              const v = vaults.find((x) => x.name === name);
              setVaultId(v?.id ?? "");
            }}
            options={vaults.map((v) => v.name)}
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field
          label="Signing key"
          hint={
            keysLoading
              ? "Loading keys…"
              : keys.length === 0
              ? "This vault has no keys yet. Add one in Vaults & Keys."
              : "The agent will be granted read access to this key only."
          }
        >
          <Select
            value={keyPath}
            onChange={setKeyPath}
            options={keys.map((k) => k.key)}
          />
        </Field>
        {keysError && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: "var(--wine)",
            }}
          >
            {keysError}
          </div>
        )}
      </div>

      {bindMcp && (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            background: "rgba(184,137,58,0.12)",
            border: "1px solid var(--brass)",
          }}
        >
          <div
            className="smallcaps"
            style={{ fontSize: 10, color: "var(--brass-deep)" }}
          >
            binding
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {bindMcp.name}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-soft)",
              marginTop: 2,
            }}
          >
            {SHORT_ADDR(bindMcp.contract)} · {bindMcp.chain}
          </div>
        </div>
      )}

      {submitError && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "rgba(140,30,40,0.08)",
            border: "1px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
          }}
        >
          {submitError}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 22,
          justifyContent: "flex-end",
        }}
      >
        <Btn kind="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Btn>
        <Btn kind="primary" disabled={!canSubmit} onClick={submit}>
          {submitting
            ? "Registering…"
            : bindMcp
            ? "Bind & register"
            : "Register agent"}
        </Btn>
      </div>
    </div>
  );
};

const RevealAgentApiKeyModal = ({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) => {
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/rotate-key`, {
        method: "POST",
      });
      const payload = (await res.json().catch(() => null)) as
        | { api_key?: string; error?: string }
        | null;
      if (!res.ok || !payload?.api_key) {
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
      setValue(payload.api_key);
      setRevealed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,24,16,0.65)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--parchment-2)",
          border: "2px solid var(--brass)",
          padding: 28,
          maxWidth: 520,
          width: "calc(100vw - 48px)",
          boxShadow: "5px 5px 0 var(--brass)",
        }}
      >
        <h3
          className="display"
          style={{ fontSize: 18, margin: 0, marginBottom: 4 }}
        >
          Reveal agent API key
        </h3>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-soft)",
            marginBottom: 16,
          }}
        >
          Agent: <span style={{ color: "var(--ink)", fontWeight: 600 }}>{agentName}</span>
        </div>

        <div
          style={{
            padding: "12px 14px",
            background: "rgba(140,30,40,0.10)",
            border: "1px solid var(--wine)",
            borderLeft: "4px solid var(--wine)",
            color: "var(--wine)",
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          <div
            className="smallcaps"
            style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}
          >
            ⚠ warning
          </div>
          Revealing the API key rotates it. The previous API key is immediately
          invalidated and any agent using it will stop working until updated.
        </div>

        <div
          className="smallcaps"
          style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}
        >
          api key
        </div>
        <div
          className="mono"
          style={{
            padding: "12px 14px",
            background: "var(--ink)",
            color: revealed && value ? "var(--brass-bright)" : "var(--ink-soft)",
            fontSize: 12,
            wordBreak: "break-all",
            userSelect: revealed ? "all" : "none",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
          }}
        >
          {revealed && value ? value : REDACTED}
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              background: "rgba(140,30,40,0.08)",
              border: "1px solid var(--wine)",
              color: "var(--wine)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          {!revealed ? (
            <>
              <Btn kind="ghost" size="sm" onClick={onClose} disabled={loading}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                size="sm"
                onClick={reveal}
                disabled={loading}
                style={{
                  background: "var(--wine)",
                  border: "1px solid var(--wine)",
                  color: "var(--parchment)",
                }}
              >
                {loading ? "Rotating…" : "I understand, rotate & reveal"}
              </Btn>
            </>
          ) : (
            <>
              <Btn kind="ghost" size="sm" onClick={copy}>
                {copied ? "Copied!" : "Copy key"}
              </Btn>
              <Btn kind="primary" size="sm" onClick={onClose}>
                Done
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const ChangeAgentKeyModal = ({
  agent,
  vaults,
  onClose,
  onChanged,
}: {
  agent: Agent;
  vaults: Vault[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) => {
  const [vaultId, setVaultId] = useState(agent.vaultId ?? vaults[0]?.id ?? "");
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keyPath, setKeyPath] = useState(agent.keyPath ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      if (!vaultId) {
        setKeys([]);
        return;
      }
      setKeysLoading(true);
      try {
        const res = await fetch(`/api/vaults/${vaultId}/secrets`, {
          signal: ac.signal,
        });
        const payload = (await res.json().catch(() => null)) as
          | { secrets?: VaultKey[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Request failed (${res.status})`);
        }
        const list = payload?.secrets ?? [];
        setKeys(list);
        if (
          !list.find(
            (k) => k.key === keyPath && vaultId === (agent.vaultId ?? vaultId),
          )
        ) {
          setKeyPath(list[0]?.key ?? "");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load keys");
      } finally {
        if (!ac.signal.aborted) setKeysLoading(false);
      }
    };
    void Promise.resolve().then(run);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const submit = async () => {
    if (submitting) return;
    if (!vaultId || !keyPath) return;
    setSubmitting(true);
    setError(null);
    try {
      if (agent.vaultId && agent.grantId) {
        const revokeRes = await fetch(
          `/api/vaults/${agent.vaultId}/key-grants/${agent.grantId}`,
          { method: "DELETE" },
        );
        if (!revokeRes.ok && revokeRes.status !== 204) {
          const payload = (await revokeRes.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(
            payload?.error ?? `Failed to revoke (${revokeRes.status})`,
          );
        }
      }
      const grantRes = await fetch(`/api/vaults/${vaultId}/key-grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          secretPathPattern: keyPath,
          permissions: ["read"],
        }),
      });
      if (!grantRes.ok) {
        const payload = (await grantRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          payload?.error ?? `Failed to grant key (${grantRes.status})`,
        );
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change key");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,24,16,0.65)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--parchment-2)",
          border: "2px solid var(--brass)",
          padding: 28,
          maxWidth: 560,
          width: "calc(100vw - 48px)",
          boxShadow: "5px 5px 0 var(--brass)",
        }}
      >
        <h3
          className="display"
          style={{ fontSize: 18, margin: 0, marginBottom: 4 }}
        >
          {agent.keyPath ? "Change signing key" : "Grant signing key"}
        </h3>
        <div
          style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 16 }}
        >
          Agent:{" "}
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>
            {agent.name}
          </span>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <Field label="Vault">
            <Select
              value={vaults.find((v) => v.id === vaultId)?.name ?? ""}
              onChange={(name) => {
                const v = vaults.find((x) => x.name === name);
                setVaultId(v?.id ?? "");
              }}
              options={vaults.map((v) => v.name)}
            />
          </Field>
          <Field
            label="Key"
            hint={
              keysLoading
                ? "Loading…"
                : keys.length === 0
                ? "No keys in this vault."
                : undefined
            }
          >
            <Select
              value={keyPath}
              onChange={setKeyPath}
              options={keys.map((k) => k.key)}
            />
          </Field>
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: "rgba(140,30,40,0.08)",
              border: "1px solid var(--wine)",
              color: "var(--wine)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          <Btn kind="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            size="sm"
            disabled={!vaultId || !keyPath || submitting}
            onClick={submit}
          >
            {submitting ? "Saving…" : agent.keyPath ? "Replace key" : "Grant key"}
          </Btn>
        </div>
      </div>
    </div>
  );
};

const NewAgentApiKeyModal = ({
  agentName,
  apiKey,
  onClose,
}: {
  agentName: string;
  apiKey: string;
  onClose: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,24,16,0.65)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--parchment-2)",
          border: "2px solid var(--brass)",
          padding: 28,
          maxWidth: 560,
          width: "calc(100vw - 48px)",
          boxShadow: "5px 5px 0 var(--brass)",
        }}
      >
        <h3
          className="display"
          style={{ fontSize: 18, margin: 0, marginBottom: 4 }}
        >
          Agent API key
        </h3>
        <div
          style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12 }}
        >
          One-time display for{" "}
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{agentName}</span>
          . Save it now — it cannot be retrieved later.
        </div>
        <div
          className="mono"
          style={{
            padding: "12px 14px",
            background: "var(--ink)",
            color: "var(--brass-bright)",
            fontSize: 12,
            wordBreak: "break-all",
            userSelect: "all",
          }}
        >
          {apiKey}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          <Btn kind="ghost" size="sm" onClick={copy}>
            {copied ? "Copied!" : "Copy"}
          </Btn>
          <Btn kind="primary" size="sm" onClick={onClose}>
            I&apos;ve saved it
          </Btn>
        </div>
      </div>
    </div>
  );
};

const ActivityFeed = ({
  compact,
}: {
  compact?: boolean;
}) => {
  const events = [
    {
      t: "6 min ago",
      who: "Karel",
      what: "called Aave.deposit",
      amount: "4,200 USDC",
      ok: true,
    },
    {
      t: "23 min ago",
      who: "Karel",
      what: "called Curve.quote",
      amount: "15 routes",
      ok: true,
    },
    {
      t: "1 hr ago",
      who: "Vlasta",
      what: "paused — exit threshold reached",
      amount: "",
      ok: false,
    },
    {
      t: "3 hr ago",
      who: "Vlasta",
      what: "called Optimism.proveWithdrawal",
      amount: "0.4 ETH",
      ok: true,
    },
    {
      t: "yesterday",
      who: "Bohumil",
      what: "called Snapshot.castVote",
      amount: "EIP-1234",
      ok: true,
    },
    {
      t: "yesterday",
      who: "Karel",
      what: "rejected — exceeded daily allowance",
      amount: "600 USDC",
      ok: false,
    },
  ];
  const slice = compact ? events.slice(0, 5) : events;
  return (
    <div
      style={{
        marginTop: 12,
        border: "1px solid var(--line)",
        background: "rgba(241,233,212,0.5)",
      }}
    >
      {slice.map((e, i) => (
        <div
          key={i}
          style={{
            padding: "12px 16px",
            borderBottom:
              i < slice.length - 1 ? "1px solid var(--line-soft)" : "none",
            display: "grid",
            gridTemplateColumns: "90px 100px 1fr auto",
            gap: 12,
            alignItems: "center",
          }}
        >
          <div
            className="smallcaps"
            style={{ fontSize: 10, color: "var(--ink-soft)" }}
          >
            {e.t}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.who}</div>
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
            {e.what}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {e.amount && (
              <span className="mono" style={{ fontSize: 12 }}>
                {e.amount}
              </span>
            )}
            <span style={{ color: e.ok ? "var(--verdigris)" : "var(--wine)" }}>
              {e.ok ? "✓" : "⚠"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};


const Settings = ({
  user,
}: {
  user: User;
}) => {
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== user.name && name.trim().length > 0;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { error: err } = await authClient.updateUser({ name: name.trim() });
      if (err) throw new Error(err.message ?? "Failed to update");
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="display" style={{ fontSize: 28, margin: 0 }}>
        Settings
      </h2>
      <div
        style={{
          marginTop: 18,
        }}
      >
        <div
          style={{
            padding: 22,
            background: "rgba(241,233,212,0.55)",
            border: "1px solid var(--line)",
          }}
        >
          <h3 className="display" style={{ fontSize: 18, margin: 0 }}>
            Profile
          </h3>
          <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
            <Field label="Display name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
              />
            </Field>
            <Field label="Wallet address">
              <Input
                readOnly
                value={user.address}
                style={{
                  fontFamily: "var(--font-mono)",
                  background: "var(--parchment-3)",
                }}
              />
            </Field>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
            }}
          >
            <Btn kind="primary" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Btn>
            {savedAt && !error && (
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                Saved.
              </span>
            )}
            {error && (
              <span style={{ fontSize: 12, color: "#a14545" }}>{error}</span>
            )}
          </div>
        </div>
    </div>
  </div>
  );
};
