const entries = new Map();

export function get(name) {
  return entries.get(name);
}

export function list() {
  return Array.from(entries.keys()).sort();
}

export function entriesList() {
  return Array.from(entries.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, meta: entry.meta }));
}

export async function set(name, entry) {
  const previous = entries.get(name);
  entries.set(name, entry);
  if (previous) {
    try {
      await previous.server.close();
    } catch (err) {
      console.error(`[registry] failed closing previous "${name}":`, err);
    }
  }
}

export async function remove(name) {
  const previous = entries.get(name);
  if (!previous) return false;
  entries.delete(name);
  try {
    await previous.server.close();
  } catch (err) {
    console.error(`[registry] failed closing "${name}":`, err);
  }
  return true;
}
