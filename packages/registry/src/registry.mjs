const entries = new Map();

export function get(name) {
  return entries.get(name);
}

export function list() {
  return Array.from(entries.keys()).sort();
}

export async function set(name, mcpServer) {
  const previous = entries.get(name);
  entries.set(name, mcpServer);
  if (previous) {
    try {
      await previous.close();
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
    await previous.close();
  } catch (err) {
    console.error(`[registry] failed closing "${name}":`, err);
  }
  return true;
}
