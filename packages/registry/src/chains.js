// 1Claw expects a chain slug (e.g. "ethereum", "sepolia") rather than a
// numeric chain id. Map by viem.Chain.id. Extend as we add chains upstream.
const ONECLAW_CHAIN_BY_ID = {
  1: "ethereum",
  11155111: "sepolia",
};

export function oneclawChainName(chainId) {
  const slug = ONECLAW_CHAIN_BY_ID[Number(chainId)];
  if (!slug) {
    throw new Error(`1Claw does not support chain id ${chainId}`);
  }
  return slug;
}
