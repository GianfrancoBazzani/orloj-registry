/**
 * Tiny local state for in-progress REBALANCE idempotency.
 * Default path: .lp-agent-state.json (cwd) or LP_AGENT_STATE_FILE.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

/**
 * @typedef {object} RebalanceDecreaseState
 * @property {"pending"|"succeeded"|"failed"} status
 * @property {string} [hash]
 * @property {unknown} [mcpResponse]
 * @property {{ maxTokenAAmount: string, maxTokenBAmount: string, tokenA: string, tokenB: string } | null} [budgets]
 * @property {string} [error]
 */

/**
 * @typedef {object} RebalanceCreateState
 * @property {"pending"|"succeeded"|"failed"|"skipped"} status
 * @property {string} [hash]
 * @property {string} [newNftTokenId]
 * @property {unknown} [mcpResponse]
 * @property {string} [error]
 */

/**
 * @typedef {object} InProgressRebalance
 * @property {string} cycleId
 * @property {string} oldNftTokenId
 * @property {string} poolAddress
 * @property {string} token0
 * @property {string} token1
 * @property {number} liquidityPercentageToDecrease
 * @property {number} rangeWidthBps
 * @property {RebalanceDecreaseState} decrease
 * @property {RebalanceCreateState} create
 * @property {string | null} newNftTokenId
 * @property {string} updatedAt
 */

/**
 * @typedef {object} LpAgentState
 * @property {number} version
 * @property {Record<string, InProgressRebalance>} inProgress keyed by oldNftTokenId
 */

/**
 * @returns {LpAgentState}
 */
export function emptyState() {
  return { version: STATE_VERSION, inProgress: {} };
}

/**
 * @param {string} filePath
 * @returns {LpAgentState}
 */
export function loadState(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("loadState requires a non-empty filePath");
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("state file root must be an object");
    }
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `unsupported state file version ${JSON.stringify(parsed.version)} (expected ${STATE_VERSION})`,
      );
    }
    if (
      parsed.inProgress === null ||
      typeof parsed.inProgress !== "object" ||
      Array.isArray(parsed.inProgress)
    ) {
      throw new Error("state.inProgress must be an object");
    }
    return {
      version: STATE_VERSION,
      inProgress: { ...parsed.inProgress },
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }
}

/**
 * @param {string} filePath
 * @param {LpAgentState} state
 */
export function saveState(filePath, state) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("saveState requires a non-empty filePath");
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("saveState requires a state object");
  }
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const payload = {
    version: STATE_VERSION,
    inProgress: state.inProgress ?? {},
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * @param {LpAgentState} state
 * @param {string} oldNftTokenId
 * @returns {InProgressRebalance | null}
 */
export function getInProgressRebalance(state, oldNftTokenId) {
  const rec = state.inProgress?.[oldNftTokenId];
  return rec && typeof rec === "object" ? rec : null;
}

/**
 * @param {LpAgentState} state
 * @param {InProgressRebalance} record
 */
export function upsertInProgressRebalance(state, record) {
  state.inProgress[record.oldNftTokenId] = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear a completed rebalance (create succeeded) or abandoned record.
 * @param {LpAgentState} state
 * @param {string} oldNftTokenId
 */
export function clearInProgressRebalance(state, oldNftTokenId) {
  delete state.inProgress[oldNftTokenId];
}

/**
 * @returns {string}
 */
export function newCycleId() {
  return `rebalance_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
