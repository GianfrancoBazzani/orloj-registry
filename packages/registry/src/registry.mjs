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
  entries.set(name, entry);
}

export async function remove(name) {
  return entries.delete(name);
}
