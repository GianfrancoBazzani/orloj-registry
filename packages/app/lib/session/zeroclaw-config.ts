import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

// Captured once at module load rather than read per call: `next dev`, `next start`, a
// standalone build and a process manager do not all agree on cwd, and a template path that
// silently misses is a 503 on every first session. Prefer absolute paths in production.
const APP_ROOT = process.cwd();

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_ALIAS = "default";

export class InvalidAgentIdError extends Error {
  constructor(agentId: string) {
    super(`Invalid agent id: ${JSON.stringify(agentId)}`);
    this.name = "InvalidAgentIdError";
  }
}

export class TemplateUnavailableError extends Error {
  constructor(templatePath: string, cause?: unknown) {
    super(`zeroclaw template config unreadable at ${templatePath}`);
    this.name = "TemplateUnavailableError";
    this.cause = cause;
  }
}

export class ZeroclawBinaryMissingError extends Error {
  constructor(bin: string) {
    super(`zeroclaw binary not found: ${bin}`);
    this.name = "ZeroclawBinaryMissingError";
  }
}

const resolveFromAppRoot = (p: string): string =>
  path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p);

export const zeroclawBin = (): string => process.env.ZEROCLAW_BIN || "zeroclaw";

const agentsRoot = (): string =>
  resolveFromAppRoot(process.env.ZEROCLAW_AGENTS_DIR || ".zeroclaw/agents");

const templateConfigPath = (): string =>
  path.join(
    resolveFromAppRoot(process.env.ZEROCLAW_TEMPLATE_DIR || "../zeroclaw-agents/default"),
    "config.toml",
  );

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const sessionTimeoutSecs = (): number =>
  intEnv("ZEROCLAW_SESSION_TIMEOUT_SECS", 3600);

export const idleTimeoutMs = (): number => intEnv("ZEROCLAW_IDLE_TIMEOUT_MS", 1_800_000);

// The single place an agent id is validated before it becomes a path segment or an argv
// slot. Pure — it creates nothing, because `GET /api/agents/[id]/mcps` and `killByAgent`
// both need the path without provisioning.
export const agentDir = (agentId: string): string => {
  if (!AGENT_ID_RE.test(agentId)) throw new InvalidAgentIdError(agentId);
  return path.join(agentsRoot(), agentId);
};

// The agent's working dir. Never the config dir: that holds the provider key, the agent's
// bearer token, and the managed block the agent could otherwise rewrite with its own tools.
export const agentWorkspaceDir = (agentId: string): string =>
  path.join(agentDir(agentId), "agents", AGENT_ALIAS, "workspace");

// zeroclaw creates data/, agents/<alias>/workspace/ and shared/ itself — but only after a
// session exists, and `session/new` rejects a cwd that is not already a directory
// (`-32602 cwd is not a usable directory`). So we create the workspace ourselves before
// every spawn: idempotent, and it also repairs a dir provisioned by an older build.
export const ensureWorkspaceDir = async (agentId: string): Promise<string> => {
  const dir = agentWorkspaceDir(agentId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
};

export const configDirExists = async (agentId: string): Promise<boolean> => {
  try {
    await access(agentDir(agentId));
    return true;
  } catch {
    return false;
  }
};

// The directory's existence is the create flag. Built in a temp sibling and renamed so an
// interrupted setup cannot leave a dir the existence check would read as provisioned.
export const provisionConfigDir = async (
  agentId: string,
): Promise<{ dir: string; created: boolean }> => {
  const dir = agentDir(agentId);
  if (await configDirExists(agentId)) return { dir, created: false };

  const template = templateConfigPath();
  try {
    await access(template);
  } catch (err) {
    throw new TemplateUnavailableError(template, err);
  }

  const root = agentsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(root, `.tmp-${agentId}-`));
  try {
    // Only config.toml. A recursive copy would clone the template's accumulated state —
    // memory, cost logs, an open SQLite session DB with live -wal/-shm — into every agent.
    // zeroclaw creates data/, agents/<alias>/workspace/ and shared/ itself on first run.
    await copyFile(template, path.join(staging, "config.toml"));
    await chmod(path.join(staging, "config.toml"), 0o600);
    await chmod(staging, 0o700);
    await rename(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    // A racing provisioner won: treat the dir as pre-existing rather than failing.
    if (
      (err as NodeJS.ErrnoException).code === "ENOTEMPTY" &&
      (await configDirExists(agentId))
    ) {
      return { dir, created: false };
    }
    throw err;
  }
  return { dir, created: true };
};

export const removeConfigDir = async (agentId: string): Promise<void> => {
  await rm(agentDir(agentId), { recursive: true, force: true });
};

const runZeroclaw = (args: string[], stdin?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(zeroclawBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "ENOENT" ? new ZeroclawBinaryMissingError(zeroclawBin()) : e);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`zeroclaw ${args[0]} exited ${code}: ${err.trim() || out.trim()}`));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

// Called by the caller AFTER the managed block is written, and only when the dir was just
// created: `config patch` re-validates the whole config, and the template's
// `mcp_bundles = ["remote"]` grant is dangling until the block defines the bundle.
export const patchAcpEnableMcp = async (dir: string): Promise<void> => {
  const ops = JSON.stringify([
    { op: "add", path: "/agents/default/acp_enable_mcp", value: true },
  ]);
  await runZeroclaw(["config", "patch", "--config-dir", dir, "-"], ops);
};
