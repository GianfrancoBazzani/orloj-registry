/**
 * Tiny local state for in-progress REBALANCE idempotency.
 * Default path: .lp-agent-state.json (cwd) or LP_AGENT_STATE_FILE.
 * Loaded records are strictly validated; key must equal oldNftTokenId.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

const UNSIGNED_DECIMAL_RE = /^(0|[1-9]\d*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECREASE_STATUSES = new Set(["pending", "succeeded", "failed"]);
const SWAP_STATUSES = new Set(["pending", "succeeded", "failed", "skipped"]);
const CREATE_STATUSES = new Set(["pending", "succeeded", "failed", "skipped"]);

/**
 * @typedef {object} RebalanceBudgets
 * @property {string} tokenA
 * @property {string} tokenB
 * @property {string} maxTokenAAmount
 * @property {string} maxTokenBAmount
 */

/**
 * @typedef {object} RebalanceDecreaseState
 * @property {"pending"|"succeeded"|"failed"} status
 * @property {string} [hash]
 * @property {unknown} [mcpResponse]
 * @property {RebalanceBudgets | null} [budgets]
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
 * @property {string[]} [ownedNftIdsBaseline] pre-rebalance owned NFT ids
 * @property {boolean} [createRetryAttempted] one-shot operator create retry flag
 * @property {RebalanceDecreaseState} decrease
 * @property {object} [swap]
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
 * @param {unknown} budgets
 * @returns {budgets is RebalanceBudgets}
 */
function isValidBudgets(budgets) {
  if (budgets === null || budgets === undefined) return true;
  if (typeof budgets !== "object" || Array.isArray(budgets)) {
    return false;
  }
  const b = /** @type {Record<string, unknown>} */ (budgets);
  return (
    typeof b.tokenA === "string" &&
    ADDRESS_RE.test(b.tokenA) &&
    typeof b.tokenB === "string" &&
    ADDRESS_RE.test(b.tokenB) &&
    typeof b.maxTokenAAmount === "string" &&
    b.maxTokenAAmount.trim() !== "" &&
    b.maxTokenAAmount !== "0" &&
    typeof b.maxTokenBAmount === "string" &&
    b.maxTokenBAmount.trim() !== "" &&
    b.maxTokenBAmount !== "0"
  );
}

/**
 * Strict validation of one in-progress rebalance record.
 * @param {string} key
 * @param {unknown} raw
 * @returns {InProgressRebalance}
 */
export function validateInProgressRecord(key, raw) {
  if (typeof key !== "string" || !UNSIGNED_DECIMAL_RE.test(key)) {
    throw new Error(`state.inProgress key must be a decimal NFT id (got ${JSON.stringify(key)})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`state.inProgress[${key}] must be an object`);
  }
  const r = /** @type {Record<string, unknown>} */ (raw);

  if (typeof r.cycleId !== "string" || r.cycleId.trim() === "") {
    throw new Error(`state.inProgress[${key}].cycleId must be a non-empty string`);
  }
  if (typeof r.oldNftTokenId !== "string" || !UNSIGNED_DECIMAL_RE.test(r.oldNftTokenId)) {
    throw new Error(`state.inProgress[${key}].oldNftTokenId must be a decimal NFT id`);
  }
  if (r.oldNftTokenId !== key) {
    throw new Error(
      `state.inProgress key ${JSON.stringify(key)} !== oldNftTokenId ${JSON.stringify(r.oldNftTokenId)}`,
    );
  }
  if (typeof r.poolAddress !== "string" || !ADDRESS_RE.test(r.poolAddress)) {
    throw new Error(`state.inProgress[${key}].poolAddress must be a 20-byte address`);
  }
  if (typeof r.token0 !== "string" || !ADDRESS_RE.test(r.token0)) {
    throw new Error(`state.inProgress[${key}].token0 must be a 20-byte address`);
  }
  if (typeof r.token1 !== "string" || !ADDRESS_RE.test(r.token1)) {
    throw new Error(`state.inProgress[${key}].token1 must be a 20-byte address`);
  }
  if (
    typeof r.liquidityPercentageToDecrease !== "number" ||
    !Number.isInteger(r.liquidityPercentageToDecrease) ||
    r.liquidityPercentageToDecrease < 1 ||
    r.liquidityPercentageToDecrease > 100
  ) {
    throw new Error(
      `state.inProgress[${key}].liquidityPercentageToDecrease must be integer 1–100`,
    );
  }
  if (
    typeof r.rangeWidthBps !== "number" ||
    !Number.isInteger(r.rangeWidthBps) ||
    r.rangeWidthBps < 1 ||
    r.rangeWidthBps > 9999
  ) {
    throw new Error(`state.inProgress[${key}].rangeWidthBps must be integer 1–9999`);
  }

  if (r.ownedNftIdsBaseline !== undefined) {
    if (!Array.isArray(r.ownedNftIdsBaseline)) {
      throw new Error(`state.inProgress[${key}].ownedNftIdsBaseline must be an array`);
    }
    for (let i = 0; i < r.ownedNftIdsBaseline.length; i++) {
      const id = r.ownedNftIdsBaseline[i];
      if (typeof id !== "string" || !UNSIGNED_DECIMAL_RE.test(id)) {
        throw new Error(
          `state.inProgress[${key}].ownedNftIdsBaseline[${i}] must be a decimal NFT id`,
        );
      }
    }
  }

  if (
    r.createRetryAttempted !== undefined &&
    typeof r.createRetryAttempted !== "boolean"
  ) {
    throw new Error(`state.inProgress[${key}].createRetryAttempted must be boolean`);
  }

  if (r.decrease === null || typeof r.decrease !== "object" || Array.isArray(r.decrease)) {
    throw new Error(`state.inProgress[${key}].decrease must be an object`);
  }
  const dec = /** @type {Record<string, unknown>} */ (r.decrease);
  if (typeof dec.status !== "string" || !DECREASE_STATUSES.has(dec.status)) {
    throw new Error(`state.inProgress[${key}].decrease.status invalid`);
  }
  if (dec.hash !== undefined && (typeof dec.hash !== "string" || !TX_HASH_RE.test(dec.hash))) {
    throw new Error(`state.inProgress[${key}].decrease.hash must be a 32-byte 0x hash`);
  }
  if (dec.status === "succeeded" && (typeof dec.hash !== "string" || !TX_HASH_RE.test(dec.hash))) {
    throw new Error(`state.inProgress[${key}].decrease succeeded requires valid hash`);
  }
  if (!isValidBudgets(dec.budgets)) {
    throw new Error(`state.inProgress[${key}].decrease.budgets invalid`);
  }

  if (r.swap !== undefined && r.swap !== null) {
    if (typeof r.swap !== "object" || Array.isArray(r.swap)) {
      throw new Error(`state.inProgress[${key}].swap must be an object`);
    }
    const sw = /** @type {Record<string, unknown>} */ (r.swap);
    if (typeof sw.status !== "string" || !SWAP_STATUSES.has(sw.status)) {
      throw new Error(`state.inProgress[${key}].swap.status invalid`);
    }
    if (sw.hash !== undefined && (typeof sw.hash !== "string" || !TX_HASH_RE.test(sw.hash))) {
      throw new Error(`state.inProgress[${key}].swap.hash must be a 32-byte 0x hash`);
    }
  }

  if (r.create === null || typeof r.create !== "object" || Array.isArray(r.create)) {
    throw new Error(`state.inProgress[${key}].create must be an object`);
  }
  const cr = /** @type {Record<string, unknown>} */ (r.create);
  if (typeof cr.status !== "string" || !CREATE_STATUSES.has(cr.status)) {
    throw new Error(`state.inProgress[${key}].create.status invalid`);
  }
  if (cr.hash !== undefined && (typeof cr.hash !== "string" || !TX_HASH_RE.test(cr.hash))) {
    throw new Error(`state.inProgress[${key}].create.hash must be a 32-byte 0x hash`);
  }
  if (
    cr.newNftTokenId !== undefined &&
    cr.newNftTokenId !== null &&
    (typeof cr.newNftTokenId !== "string" || !UNSIGNED_DECIMAL_RE.test(cr.newNftTokenId))
  ) {
    throw new Error(`state.inProgress[${key}].create.newNftTokenId must be a decimal NFT id`);
  }

  if (
    r.newNftTokenId !== null &&
    r.newNftTokenId !== undefined &&
    (typeof r.newNftTokenId !== "string" || !UNSIGNED_DECIMAL_RE.test(r.newNftTokenId))
  ) {
    throw new Error(`state.inProgress[${key}].newNftTokenId must be null or decimal NFT id`);
  }

  if (typeof r.updatedAt !== "string" || r.updatedAt.trim() === "") {
    throw new Error(`state.inProgress[${key}].updatedAt must be a non-empty string`);
  }

  return /** @type {InProgressRebalance} */ (r);
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

    /** @type {Record<string, InProgressRebalance>} */
    const inProgress = {};
    for (const [key, value] of Object.entries(parsed.inProgress)) {
      inProgress[key] = validateInProgressRecord(key, value);
    }
    return {
      version: STATE_VERSION,
      inProgress,
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
  // Re-validate before write so corrupt records never persist.
  /** @type {Record<string, InProgressRebalance>} */
  const validated = {};
  for (const [key, value] of Object.entries(state.inProgress ?? {})) {
    validated[key] = validateInProgressRecord(key, value);
  }
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const payload = {
    version: STATE_VERSION,
    inProgress: validated,
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
  const next = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  validateInProgressRecord(next.oldNftTokenId, next);
  state.inProgress[next.oldNftTokenId] = next;
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

/**
 * Collect every owned NFT id from a list_v3_positions response (baseline).
 * Requires truncated===false.
 * @param {unknown} listed
 * @returns {{ ok: true, ids: string[] } | { ok: false, reason: string }}
 */
export function ownedNftIdsFromList(listed) {
  if (listed === null || typeof listed !== "object" || Array.isArray(listed)) {
    return { ok: false, reason: "list_not_object" };
  }
  const L = /** @type {Record<string, unknown>} */ (listed);
  if (L.truncated !== false) {
    return { ok: false, reason: "list_truncated" };
  }
  if (!Array.isArray(L.positions)) {
    return { ok: false, reason: "list_positions_not_array" };
  }
  /** @type {string[]} */
  const ids = [];
  for (const p of L.positions) {
    if (!p || typeof p !== "object") {
      return { ok: false, reason: "list_entry_not_object" };
    }
    const id = /** @type {Record<string, unknown>} */ (p).nftTokenId;
    if (typeof id !== "string" || !UNSIGNED_DECIMAL_RE.test(id)) {
      return { ok: false, reason: "list_entry_bad_nftTokenId" };
    }
    ids.push(id);
  }
  return { ok: true, ids };
}
