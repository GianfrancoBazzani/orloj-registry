import { randomUUID } from "node:crypto";
import { getActiveTokenForAgent } from "@/lib/mcp-tokens";
import { ZeroClawAcpSession } from "./acp-client";
import { writeMcpSelection, type McpSelectionItem } from "./mcp-block";
import { resolveMcpServers } from "./mcp-servers";
import {
  applyManagedConfig,
  ensureWorkspaceDir,
  idleTimeoutMs,
  provisionConfigDir,
} from "./zeroclaw-config";

export class NoActiveTokenError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} has no active MCP API key`);
    this.name = "NoActiveTokenError";
  }
}

export type LiveSession = {
  sessionId: string;
  agentId: string;
  userId: string;
  acpSessionId: string;
  session: ZeroClawAcpSession;
  mcps: McpSelectionItem[];
  lastSeen: number;
  busy: boolean;
};

export type CreateResult = {
  sessionId: string;
  acpSessionId: string;
  resumed: boolean;
  mcps: McpSelectionItem[];
  // Names the requested selection asked for that the registry no longer publishes. The
  // session started without them and the stored selection has been rewritten without them,
  // so this is the only chance to tell the user they are gone.
  dropped: string[];
};

type Store = {
  sessions: Map<string, LiveSession>;
  creating: Map<string, Promise<CreateResult>>;
  sweeper: NodeJS.Timeout | null;
  hooked: boolean;
};

// Pinned on globalThis under a symbol: Next.js dev HMR reloads this module, and a
// module-local Map would orphan child processes while a module-local interval would stack a
// new sweeper on every reload.
const KEY = Symbol.for("orloj.session.registry");
const globalStore = globalThis as unknown as Record<symbol, Store | undefined>;
const store: Store = (globalStore[KEY] ??= {
  sessions: new Map(),
  creating: new Map(),
  sweeper: null,
  hooked: false,
});

const destroyEntry = (entry: LiveSession): void => {
  try {
    entry.session.destroy();
  } catch {
    // a child that is already gone is the outcome we wanted
  }
  store.sessions.delete(entry.sessionId);
};

export const killByAgent = (agentId: string): void => {
  for (const entry of [...store.sessions.values()]) {
    if (entry.agentId === agentId) destroyEntry(entry);
  }
};

export const sessionForAgent = (agentId: string, userId: string): LiveSession | undefined => {
  for (const entry of store.sessions.values()) {
    if (entry.agentId === agentId && entry.userId === userId) return entry;
  }
  return undefined;
};

// A userId mismatch reads as absent, so session ids are not probeable.
export const getSession = (sessionId: string, userId: string): LiveSession | undefined => {
  const entry = store.sessions.get(sessionId);
  return entry && entry.userId === userId ? entry : undefined;
};

export const touch = (entry: LiveSession): void => {
  entry.lastSeen = Date.now();
};

export const endSession = (sessionId: string, userId: string): boolean => {
  const entry = getSession(sessionId, userId);
  if (!entry) return false;
  destroyEntry(entry);
  return true;
};

const ensureSweeper = (): void => {
  if (store.sweeper) return;
  const interval = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs();
    for (const entry of [...store.sessions.values()]) {
      if (!entry.busy && entry.lastSeen < cutoff) destroyEntry(entry);
    }
  }, 60_000);
  interval.unref();
  store.sweeper = interval;
};

const ensureShutdownHooks = (): void => {
  if (store.hooked) return;
  store.hooked = true;
  const destroyAll = () => {
    for (const entry of [...store.sessions.values()]) destroyEntry(entry);
  };
  // `exit` alone is not enough — it does not fire for signal-terminated processes, so a
  // `next start` under a process manager would leave zeroclaw children behind.
  process.on("exit", destroyAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      destroyAll();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
};

const doCreate = async (opts: {
  agentId: string;
  userId: string;
  mcpNames: string[];
  acpSessionId?: string;
}): Promise<CreateResult> => {
  const { agentId, userId, mcpNames, acpSessionId } = opts;

  const token = await getActiveTokenForAgent(agentId);
  if (!token) throw new NoActiveTokenError(agentId);

  // Resolved BEFORE anything is created on disk. The config dir's existence is the
  // "configured" flag, so a start that fails on a fully stale selection or an unreachable
  // registry must not leave a dir behind — that would strand the agent as
  // configured-with-no-MCPs, hiding the wizard for good and silently ignoring the next
  // start's selection.
  const { entries, dropped } = await resolveMcpServers(mcpNames, token);

  const { dir } = await provisionConfigDir(agentId);
  // session/new rejects a cwd that does not exist yet, and zeroclaw only creates the
  // workspace once a session exists. Idempotent, so it also repairs an older dir.
  const workspaceDir = await ensureWorkspaceDir(agentId);

  // Starting a session replaces any live one for this agent (a non-goal: concurrency).
  killByAgent(agentId);
  // Rewritten on every start even when the selection has not changed: the token is written
  // into config.toml, so rotating an agent's key stales its dir. Writing only the resolved
  // entries is also what retires a stale name for good — the next read of the sidecar no
  // longer carries it.
  const mcps = await writeMcpSelection(dir, entries);
  // Must follow writeMcpSelection: it validates the config it patches, and the `remote` bundle
  // grant does not resolve until the managed block has defined the bundle.
  await applyManagedConfig(dir);

  const session = new ZeroClawAcpSession({ configDir: dir, workspaceDir });
  try {
    await session.spawn();
    await session.initialize();
    let resumed = false;
    if (acpSessionId) resumed = await session.loadSession(acpSessionId);
    if (!resumed) await session.newSession();
  } catch (err) {
    session.destroy();
    throw err;
  }

  const acpId = session.acpSessionId;
  if (!acpId) {
    session.destroy();
    throw new Error("zeroclaw returned no session id");
  }

  const entry: LiveSession = {
    sessionId: randomUUID(),
    agentId,
    userId,
    acpSessionId: acpId,
    session,
    mcps,
    lastSeen: Date.now(),
    busy: false,
  };
  store.sessions.set(entry.sessionId, entry);
  ensureSweeper();
  ensureShutdownHooks();
  return {
    sessionId: entry.sessionId,
    acpSessionId: acpId,
    resumed: Boolean(acpSessionId) && acpId === acpSessionId,
    mcps,
    dropped,
  };
};

// Serialised per agent: without the lock, StrictMode's double mount, two tabs, or a
// double-clicked "Start session" all leave a client holding a session id that was killed a
// millisecond after it was issued.
export const createSession = async (opts: {
  agentId: string;
  userId: string;
  mcpNames: string[];
  acpSessionId?: string;
}): Promise<CreateResult> => {
  const inflight = store.creating.get(opts.agentId);
  if (inflight) return inflight;
  const promise = doCreate(opts).finally(() => store.creating.delete(opts.agentId));
  store.creating.set(opts.agentId, promise);
  return promise;
};

// Keeps the process and its warm MCP connections; swaps in a new conversation.
export const resetSession = async (
  sessionId: string,
  userId: string,
): Promise<string | null> => {
  const entry = getSession(sessionId, userId);
  if (!entry) return null;
  const next = await entry.session.resetSession();
  entry.acpSessionId = next;
  touch(entry);
  return next;
};
