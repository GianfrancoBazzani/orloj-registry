/**
 * ACP handshake probe. Not part of the app — a standalone check of the
 * @agentclientprotocol/sdk 1.3.0 ↔ zeroclaw 0.8.3 pairing.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/acp-probe.mts
 *   npx tsx --tsconfig tsconfig.json scripts/acp-probe.mts --with-mcp <mcpName> [--load]
 *
 * With --with-mcp it writes a real managed block (needs REGISTRY_URL up and MCP_TOKEN set)
 * and prompts for a tool call. With --load it then closes the process and loads the same
 * ACP session in a fresh one, re-listing tools — spec unknowns #3 and #4.
 */
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PermissionOption,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { writeMcpSelection } from "../lib/session/mcp-block.js";
import { resolveMcpServers } from "../lib/session/mcp-servers.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string) => args.includes(name);

const BIN = process.env.ZEROCLAW_BIN || "zeroclaw";
const TEMPLATE = process.env.ZEROCLAW_TEMPLATE_DIR || "../zeroclaw-agents/default";

const connect = (dir: string) => {
  const child = spawn(
    BIN,
    ["acp", "--config-dir", dir, "--max-sessions", "1", "--session-timeout", "3600"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => process.stderr.write(`[zeroclaw] ${c}`));
  const client: Client = {
    requestPermission: (p: RequestPermissionRequest) => {
      const opts = p.options ?? [];
      const pick =
        opts.find((o: PermissionOption) => o.kind === "allow_always") ??
        opts.find((o: PermissionOption) => o.kind === "allow_once") ??
        opts[0];
      console.log("[permission]", p.toolCall?.title ?? "", "->", pick?.optionId);
      return pick
        ? { outcome: { outcome: "selected" as const, optionId: pick.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    },
    sessionUpdate: (p: SessionNotification) => {
      console.log("[update]", JSON.stringify(p.update).slice(0, 400));
    },
  };
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  return { child, conn: new ClientSideConnection(() => client, stream) };
};

const dir = await mkdtemp(path.join(os.tmpdir(), "orloj-probe-"));
await copyFile(path.join(TEMPLATE, "config.toml"), path.join(dir, "config.toml"));

const mcpName = flag("--with-mcp");
if (mcpName) {
  const token = process.env.MCP_TOKEN;
  if (!token) throw new Error("--with-mcp needs MCP_TOKEN set to a live mcpk_live_* token");
  const { entries, dropped } = await resolveMcpServers([mcpName], token);
  if (dropped.length > 0) console.log("[dropped]", JSON.stringify(dropped));
  console.log("[block]", JSON.stringify(entries.map((e) => ({ ...e, bearerToken: "***" }))));
  await writeMcpSelection(dir, entries);
} else {
  await writeMcpSelection(dir, []);
}

await new Promise<void>((resolve, reject) => {
  const p = spawn(BIN, ["config", "patch", "--config-dir", dir, "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`patch exited ${c}`))));
  p.stdin.end(
    JSON.stringify([{ op: "add", path: "/agents/default/acp_enable_mcp", value: true }]),
  );
});

// session/new rejects a cwd that is not already a directory, and zeroclaw only creates the
// workspace lazily — mirror provisionConfigDir's ensureWorkspaceDir.
const cwd = path.join(dir, "agents", "default", "workspace");
await mkdir(cwd, { recursive: true, mode: 0o700 });
const { child, conn } = connect(dir);

const init = await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log("[initialize]", JSON.stringify(init, null, 2));

const newParams = { cwd, mcpServers: [], agentAlias: "default" } as NewSessionRequest;
const ns = await conn.newSession(newParams);
console.log("[session/new]", JSON.stringify(ns, null, 2));

const ask = mcpName
  ? `List every tool you have available, by name. Then call the one that reads a balance and tell me the result.`
  : `Reply with exactly: PROBE OK`;
const res = await conn.prompt({ sessionId: ns.sessionId, prompt: [{ type: "text", text: ask }] });
console.log("[prompt done]", JSON.stringify(res));

if (has("--load")) {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  console.log("\n=== reloading in a fresh process ===");
  const second = connect(dir);
  await second.conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const loaded = await second.conn
    .loadSession({ ...newParams, sessionId: ns.sessionId } as LoadSessionRequest)
    .then(() => true)
    .catch((e) => {
      console.log("[session/load failed]", e instanceof Error ? e.message : e);
      return false;
    });
  console.log("[session/load]", loaded);
  if (loaded) {
    const after = await second.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "List every tool you have available, by name." }],
    });
    console.log("[post-load prompt]", JSON.stringify(after));
  }
  second.child.kill("SIGTERM");
} else {
  child.kill("SIGTERM");
}

console.log("\nprobe dir:", dir);
process.exit(0);
