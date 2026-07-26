/**
 * Framework-independent JSON-RPC MCP dispatcher for the Graph LP chat bridge.
 * Envelope conventions mirror packages/registry Uniswap MCP (initialize / tools / call).
 */

import { runOnce as defaultRunOnce } from "./run-once.mjs";
import { redactSecrets } from "./orloj-mcp-client.mjs";
import {
  ANALYZE_TOOL,
  MANAGE_TOOL,
  acquireAgentCycleLock,
  buildTrustedChatConfig,
} from "./chat-bridge.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "orloj-lp-manager";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Graph LP Manager: one-cycle specialized Uniswap V3 LP analysis/management for Orloj.",
  "ZeroClaw is the conversational supervisor only — this server runs the deterministic LP pipeline (The Graph + specialized 0G inference + Orloj Uniswap MCP).",
  "Tools manage existing active Sepolia (11155111) V3 positions owned by the authenticated Orloj agent.",
  "They do not create an initial LP when the wallet owns no active position.",
  "analyze_uniswap_v3_positions always observes (no on-chain writes).",
  "manage_uniswap_v3_positions runs one guarded execute cycle when the server enables it.",
  "Do not pass wallet, chain, NFT, mode, API keys, state paths, or retry flags — the server ignores caller routing arguments.",
].join(" ");

/**
 * @typedef {object} LpAgentMcpDispatcherOptions
 * @property {(deps?: object) => Promise<object>} [runOnceFn]
 * @property {boolean} [executeEnabled]
 * @property {(mode: "observe"|"execute") => object | Promise<object>} buildConfig
 *   Returns trusted fields for buildTrustedChatConfig (without agentMode — set by tool).
 * @property {string} agentId
 */

/**
 * @param {unknown} id
 * @param {unknown} result
 */
function jsonRpcOk(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/**
 * @param {unknown} audit
 * @returns {boolean}
 */
function isErrorAuditStatus(audit) {
  if (!audit || typeof audit !== "object") return true;
  const status = /** @type {{ status?: unknown }} */ (audit).status;
  return status === "partial" || status === "error";
}

/**
 * @param {unknown} id
 * @param {unknown} audit
 */
function toolCallResultFromAudit(id, audit) {
  return jsonRpcOk(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(audit),
      },
    ],
    isError: isErrorAuditStatus(audit),
  });
}
function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

/**
 * @param {boolean} executeEnabled
 */
function listTools(executeEnabled) {
  /** @type {object[]} */
  const tools = [
    {
      name: ANALYZE_TOOL,
      description:
        "Analyze all existing active Uniswap V3 positions on Ethereum Sepolia owned by the authenticated Orloj agent using live The Graph data and specialized LP inference. Observe-only: never executes transactions, never creates an initial LP, and never writes. Takes no wallet/token/pool/NFT/chain/mode arguments.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  if (executeEnabled) {
    tools.push({
      name: MANAGE_TOOL,
      description:
        "Run exactly one guarded manage cycle for all existing active Uniswap V3 positions on Sepolia owned by the authenticated Orloj agent (HOLD / REDUCE / REBALANCE via decrease→optional swap→create). Does not create an initial LP when none exist. Takes no routing or wallet arguments. Server-enforced execute mode.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  }
  return tools;
}

/**
 * Strip secrets from a serializable audit payload.
 * @param {unknown} value
 * @param {string[]} secrets
 */
function scrubSecretsDeep(value, secrets) {
  if (value == null) return value;
  if (typeof value === "string") {
    let out = value;
    for (const s of secrets) {
      if (s) out = redactSecrets(out, s);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubSecretsDeep(v, secrets));
  }
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes("apikey") ||
        keyLower.includes("api_key") ||
        keyLower.includes("bearer") ||
        keyLower.includes("authorization") ||
        keyLower === "orlojmcpapikey" ||
        keyLower === "aiapikey" ||
        keyLower === "thegraphapikey"
      ) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = scrubSecretsDeep(v, secrets);
    }
    return out;
  }
  return value;
}

/**
 * @param {LpAgentMcpDispatcherOptions} options
 */
export function createLpAgentMcpDispatcher(options) {
  if (!options || typeof options !== "object") {
    throw new Error("createLpAgentMcpDispatcher requires options");
  }
  const {
    agentId,
    buildConfig,
    runOnceFn = defaultRunOnce,
    executeEnabled = false,
  } = options;
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("agentId is required");
  }
  if (typeof buildConfig !== "function") {
    throw new Error("buildConfig callback is required");
  }

  /**
   * @param {"observe"|"execute"} mode
   */
  async function invokeRunOnce(mode) {
    const release = acquireAgentCycleLock(agentId);
    /** @type {string[]} */
    let secrets = [];
    try {
      const base = await buildConfig(mode);
      const config = buildTrustedChatConfig({
        ...base,
        agentId,
        agentMode: mode,
      });
      // Force mode again — never allow base to override tool selection.
      config.agentMode = mode;
      config.allowCreateRetry = false;
      config.allowCreateRetryCycleId = null;
      config.nftTokenId = null;
      secrets = [
        config.orlojMcpApiKey,
        config.aiApiKey,
        config.theGraphApiKey,
        typeof base?.orlojBearerToken === "string" ? base.orlojBearerToken : "",
      ];

      const result = await runOnceFn({ config });
      return scrubSecretsDeep(result, secrets);
    } catch (err) {
      const raw =
        err && typeof err === "object" && "message" in err
          ? String(err.message)
          : String(err);
      let message = raw;
      for (const s of secrets) {
        if (s) message = redactSecrets(message, s);
      }
      const wrapped = new Error(message);
      if (err && typeof err === "object" && "code" in err) {
        wrapped.code = err.code;
      }
      throw wrapped;
    } finally {
      release();
    }
  }

  /**
   * @param {unknown} body
   * @returns {Promise<object | null>} null → HTTP 202 for notifications
   */
  async function dispatch(body) {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return jsonRpcError(null, -32700, "parse error: expected JSON-RPC object");
    }
    const method = typeof body.method === "string" ? body.method : "";
    const id = "id" in body ? body.id : null;
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? body.params
        : {};

    switch (method) {
      case "initialize":
        return jsonRpcOk(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return jsonRpcOk(id, {});
      case "tools/list":
        return jsonRpcOk(id, { tools: listTools(Boolean(executeEnabled)) });
      case "tools/call": {
        const toolName =
          typeof params.name === "string" ? params.name : "";
        // Caller arguments are intentionally ignored (security invariant).
        if (toolName === ANALYZE_TOOL) {
          try {
            const audit = await invokeRunOnce("observe");
            return toolCallResultFromAudit(id, audit);
          } catch (err) {
            const message =
              err && typeof err === "object" && "message" in err
                ? String(err.message)
                : String(err);
            const code =
              err && typeof err === "object" && err.code === "LP_AGENT_BUSY"
                ? "LP_AGENT_BUSY"
                : undefined;
            return jsonRpcOk(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "error",
                    error: message,
                    ...(code ? { code } : {}),
                  }),
                },
              ],
              isError: true,
            });
          }
        }
        if (toolName === MANAGE_TOOL) {
          if (!executeEnabled) {
            return jsonRpcOk(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "error",
                    error:
                      "manage_uniswap_v3_positions is disabled (LP_AGENT_CHAT_EXECUTE_ENABLED is not true)",
                  }),
                },
              ],
              isError: true,
            });
          }
          try {
            const audit = await invokeRunOnce("execute");
            return toolCallResultFromAudit(id, audit);
          } catch (err) {
            const message =
              err && typeof err === "object" && "message" in err
                ? String(err.message)
                : String(err);
            const code =
              err && typeof err === "object" && err.code === "LP_AGENT_BUSY"
                ? "LP_AGENT_BUSY"
                : undefined;
            return jsonRpcOk(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "error",
                    error: message,
                    ...(code ? { code } : {}),
                  }),
                },
              ],
              isError: true,
            });
          }
        }
        return jsonRpcOk(id, {
          content: [
            {
              type: "text",
              text: `unknown tool: ${toolName || "(missing)"}`,
            },
          ],
          isError: true,
        });
      }
      default:
        return jsonRpcError(id, -32601, `method not found: ${method || "(missing)"}`);
    }
  }

  return { dispatch, listTools: () => listTools(Boolean(executeEnabled)) };
}
