import { fetchIndex } from "@orloj/skills-marketplace/gateway";
import type { MarketplacePointer, SkillsIndex } from "@orloj/skills-marketplace/types";
import rawPointer from "@orloj/skills-marketplace/marketplace.json";

/**
 * The skills catalog, read from 0G Storage.
 *
 * `marketplace.json` is committed and tiny — it is only a pointer. The catalog
 * itself lives on 0G and is fetched by root hash and Merkle-verified, so
 * publishing a new index needs a pointer bump rather than a code change.
 */

const pointer = rawPointer as MarketplacePointer;

export const indexerUrl = (): string =>
  process.env.ZG_INDEXER_URL || pointer.network.indexerRpc;

const ttlMs = (): number => {
  const raw = process.env.ZG_INDEX_TTL_MS;
  if (!raw) return 300_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
};

// StorageScan exposes no working per-root-hash view — /file/<root>, /file-detail/<root> and
// /search?keyword=<root> all 404 — so these two are the only provenance links there are.
// Verified 2026-07-26. Do not invent a per-file URL.
const STORAGESCAN_ADDRESS = "https://storagescan.0g.ai/address/";
const CHAINSCAN_TX = "https://chainscan.0g.ai/tx/";

type Cache = { index: SkillsIndex; at: number };
type Store = { cache: Cache | null; inflight: Promise<SkillsIndex> | null };

// Pinned on globalThis under a symbol for the same reason lib/session/registry.ts does it:
// Next.js dev HMR reloads this module, and a module-local cache would be silently discarded
// on every edit, turning every panel open into a fresh 0G round trip.
const KEY = Symbol.for("orloj.skill.catalog");
const globalStore = globalThis as unknown as Record<symbol, Store | undefined>;
const store: Store = (globalStore[KEY] ??= { cache: null, inflight: null });

export const loadIndex = async (): Promise<SkillsIndex> => {
  const fresh = store.cache && Date.now() - store.cache.at < ttlMs();
  if (fresh && store.cache) return store.cache.index;

  // Shared so a burst of panel opens makes one request, not one per caller.
  if (store.inflight) return store.inflight;

  const promise = fetchIndex({ pointer, indexerUrl: indexerUrl() })
    .then((index) => {
      store.cache = { index, at: Date.now() };
      return index;
    })
    .finally(() => {
      store.inflight = null;
    });

  store.inflight = promise;
  return promise;
};

export type CatalogSkill = {
  name: string;
  description: string;
  sizeBytes: number;
  contentHash: string;
  fileCount: number;
};

export type SkillCatalog = {
  skills: CatalogSkill[];
  network: SkillsIndex["network"];
  indexRoot: string;
  publisher?: string;
  explorer: { publisher?: string; indexTx: string };
};

export const catalogPayload = async (): Promise<SkillCatalog> => {
  const index = await loadIndex();
  return {
    skills: index.skills.map((s) => ({
      name: s.name,
      description: s.description,
      sizeBytes: s.sizeBytes,
      contentHash: s.contentHash,
      fileCount: s.files.length,
    })),
    network: index.network,
    indexRoot: pointer.indexRoot,
    publisher: pointer.publisher,
    explorer: {
      publisher: pointer.publisher ? `${STORAGESCAN_ADDRESS}${pointer.publisher}` : undefined,
      indexTx: `${CHAINSCAN_TX}${pointer.indexTxHash}`,
    },
  };
};
