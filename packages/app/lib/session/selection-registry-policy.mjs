/**
 * Pure policy: when the registry manifest cannot be fetched, may we still resolve?
 * Only if every selected MCP is the app-owned internal LP Manager.
 *
 * @param {string[]} mcpNames
 * @param {string | null} internalMcpId
 * @returns {boolean} true when registry reachability is required
 */
export function selectionRequiresRegistry(mcpNames, internalMcpId) {
  const requested = [...new Set(mcpNames)];
  if (requested.length === 0) return false;
  if (internalMcpId == null) return true;
  return !requested.every((name) => name === internalMcpId);
}
