import chokidar from "chokidar";
import path from "node:path";

const DEBOUNCE_MS = 150;

export function watchMcps(mcpsDir, { onSync, onRemove }) {
  const pending = new Map();
  const queueSync = (name) => {
    const prev = pending.get(name);
    if (prev) clearTimeout(prev);
    pending.set(
      name,
      setTimeout(() => {
        pending.delete(name);
        onSync(name);
      }, DEBOUNCE_MS),
    );
  };
  const queueRemove = (name) => {
    const prev = pending.get(name);
    if (prev) {
      clearTimeout(prev);
      pending.delete(name);
    }
    onRemove(name);
  };

  const nameOf = (filepath) => {
    const rel = path.relative(mcpsDir, filepath);
    if (!rel || rel.startsWith("..")) return null;
    const [first] = rel.split(path.sep);
    return first || null;
  };

  const watcher = chokidar.watch(mcpsDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    depth: 5,
  });

  watcher.on("addDir", (p) => {
    const name = nameOf(p);
    if (name && p !== mcpsDir) queueSync(name);
  });
  watcher.on("add", (p) => {
    const name = nameOf(p);
    if (name) queueSync(name);
  });
  watcher.on("change", (p) => {
    const name = nameOf(p);
    if (name) queueSync(name);
  });
  watcher.on("unlinkDir", (p) => {
    const name = nameOf(p);
    if (name && path.relative(mcpsDir, p) === name) queueRemove(name);
  });
  watcher.on("unlink", (p) => {
    const name = nameOf(p);
    if (name) queueSync(name);
  });
  watcher.on("error", (err) => {
    console.error("[watcher]", err);
  });

  return {
    ready: new Promise((resolve) => watcher.once("ready", resolve)),
    close: () => watcher.close(),
  };
}
