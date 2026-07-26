import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchVerified } from "@orloj/skills-marketplace/gateway";
import { isValidSkillName, planInstall } from "@orloj/skills-marketplace/install-plan";
import type { IndexedSkill } from "@orloj/skills-marketplace/types";
import { indexerUrl } from "./skill-catalog";
import { skillsCacheDir, skillsDir } from "./zeroclaw-config";

/**
 * Installing and removing skills in an agent's workspace.
 *
 * The filesystem is the only state there is: no sidecar, no table. The agent
 * runs with `risk_profile = "yolo"` and `workspace_only = false`, so it can edit
 * its own workspace; a stored selection would drift from what is actually on
 * disk, and a `readdir` cannot.
 */

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The skills currently installed for an agent.
 *
 * A missing `skills/` directory is `[]`, never an error — an agent that has
 * never had a skill is the common case. Staging directories are excluded for
 * free: `.tmp-…` fails the skill-name regex.
 */
export const readInstalledSkills = async (agentId: string): Promise<string[]> => {
  const dir = skillsDir(agentId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue;
    // A directory without a SKILL.md is not a skill zeroclaw would load, so reporting it
    // would make the UI claim something the agent cannot see.
    if (await exists(path.join(dir, entry.name, "SKILL.md"))) names.push(entry.name);
  }
  return names.sort(byString);
};

// Safe to return without re-verifying: the filename IS the Merkle root, and nothing is
// written under that name until fetchVerified has proven the bytes match it.
const cachedBytes = async (rootHash: string, sizeBytes: number): Promise<Uint8Array> => {
  const cacheDir = skillsCacheDir();
  const key = rootHash.toLowerCase();
  const target = path.join(cacheDir, key);

  try {
    const hit = await readFile(target);
    if (hit.length === sizeBytes) return new Uint8Array(hit);
  } catch {
    // miss, or a truncated entry from an interrupted write — refetch either way
  }

  const bytes = await fetchVerified({
    indexerUrl: indexerUrl(),
    rootHash: key,
    expectedSize: sizeBytes,
  });

  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(cacheDir, `.tmp-${key}-${process.pid}`);
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, target);
  } catch {
    // A cache that cannot be written must never fail an install.
  }

  return bytes;
};

const installOne = async (agentId: string, skill: IndexedSkill): Promise<void> => {
  const root = skillsDir(agentId);
  await mkdir(root, { recursive: true, mode: 0o700 });

  // Every file is downloaded and verified BEFORE anything is staged, so a skill that fails
  // halfway never leaves a partial directory the agent would read as complete.
  const files = await Promise.all(
    skill.files.map(async (f) => ({
      path: f.path,
      bytes: await cachedBytes(f.rootHash, f.sizeBytes),
    })),
  );

  const staging = await mkdtemp(path.join(root, `.tmp-${skill.name}-`));
  try {
    for (const file of files) {
      const abs = path.resolve(staging, file.path);
      // planInstall already proved the path cannot escape. This assertion is what turns a
      // future loosening of that regex into a loud failure instead of a silent write outside
      // the workspace.
      if (abs !== staging && !abs.startsWith(staging + path.sep)) {
        throw new Error(`skill ${skill.name}: path ${file.path} escapes its directory`);
      }
      await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      await writeFile(abs, file.bytes, { mode: 0o600 });
    }
    // rename onto a non-empty directory fails, so the old copy goes first. Between these two
    // lines the skill is briefly absent; that is fine, because zeroclaw only reads the
    // directory when a session starts and the respawn happens after this returns.
    await rm(path.join(root, skill.name), { recursive: true, force: true });
    await rename(staging, path.join(root, skill.name));
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
};

export type SyncResult = {
  /** What is installed after the sync. */
  skills: string[];
  /** Requested names the published index does not carry. */
  dropped: string[];
};

export const syncSkills = async (args: {
  agentId: string;
  requested: string[];
  index: IndexedSkill[];
}): Promise<SyncResult> => {
  const { agentId, requested, index } = args;
  const installed = await readInstalledSkills(agentId);

  // Throws SkillPlanError on an oversized selection, a bad name, or a skill whose declared
  // files fail path hardening. Nothing has touched the disk at this point.
  const plan = planInstall({ requested, installed, index });

  for (const skill of plan.install) await installOne(agentId, skill);

  const root = skillsDir(agentId);
  for (const name of plan.remove) {
    // Re-checked rather than trusted: this value reaches `rm -rf`.
    if (!isValidSkillName(name)) continue;
    await rm(path.join(root, name), { recursive: true, force: true });
  }

  return {
    skills: [...plan.keep, ...plan.install.map((s) => s.name)].sort(byString),
    dropped: plan.dropped,
  };
};
