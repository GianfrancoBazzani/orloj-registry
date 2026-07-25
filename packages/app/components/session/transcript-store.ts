import type { UIMessage } from "ai";

// Keyed by user as well as agent: a shared browser must not show one account's thread after
// another signs in. Cleared on sign-out for the same reason.
export const transcriptKey = (userId: string, agentId: string): string =>
  `orloj.chat.${userId}.${agentId}`;

export type StoredTranscript = { acpSessionId: string | null; messages: UIMessage[] };

const EMPTY: StoredTranscript = { acpSessionId: null, messages: [] };
// The ~5 MB localStorage budget is shared with everything else on the origin.
const MAX_BYTES = 500 * 1024;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Text parts only. Never the bearer token, never anything from the MCP config.
const textOnly = (messages: UIMessage[]): UIMessage[] =>
  messages
    .map((m) => ({
      id: m.id,
      role: m.role,
      parts: (m.parts ?? []).filter((p) => p.type === "text"),
    }))
    .filter((m) => m.parts.length > 0) as UIMessage[];

export const readTranscript = (userId: string, agentId: string): StoredTranscript => {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(transcriptKey(userId, agentId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as StoredTranscript;
    if (!parsed || !Array.isArray(parsed.messages)) return EMPTY;
    const acpSessionId =
      typeof parsed.acpSessionId === "string" && UUID_RE.test(parsed.acpSessionId)
        ? parsed.acpSessionId
        : null;
    return { acpSessionId, messages: textOnly(parsed.messages) };
  } catch {
    // An oversized or corrupt entry degrades to an empty transcript; it never throws.
    return EMPTY;
  }
};

export const writeTranscript = (
  userId: string,
  agentId: string,
  value: StoredTranscript,
): void => {
  if (typeof window === "undefined") return;
  const key = transcriptKey(userId, agentId);
  let messages = textOnly(value.messages);
  // Keep the most recent messages under the cap, dropping oldest first.
  for (;;) {
    const payload = JSON.stringify({ acpSessionId: value.acpSessionId, messages });
    if (payload.length <= MAX_BYTES || messages.length === 0) {
      try {
        window.localStorage.setItem(key, payload);
      } catch {
        // QuotaExceededError: a write that fails must not break the chat.
      }
      return;
    }
    messages = messages.slice(1);
  }
};

export const clearTranscript = (userId: string, agentId: string): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(transcriptKey(userId, agentId));
  } catch {
    // nothing to do
  }
};
