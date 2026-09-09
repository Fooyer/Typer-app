// Persisted per connection+namespace (mirrors themePreference.ts's localStorage pattern) so a
// prompt typed last week is still there after closing the agent tab or restarting the app —
// AgentPanel's own state resets whenever its tab is closed and reopened, which this is meant to
// survive.
const MAX_ENTRIES = 50;

export interface PromptHistoryEntry {
  prompt: string;
  timestamp: number;
  /** Which opencode chat (see agentSession.ts) this prompt was sent in — undefined for entries
   * saved before this field existed, or if the session id wasn't known yet at save time (see
   * tagLatestPromptHistoryEntry). Used to group/visually separate entries by chat in the UI. */
  sessionId?: string;
}

function storageKey(connectionId: string, namespace: string): string {
  return `typer.agent-prompt-history::${connectionId}::${namespace}`;
}

function isPromptHistoryEntry(value: unknown): value is PromptHistoryEntry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PromptHistoryEntry).prompt === "string" &&
    typeof (value as PromptHistoryEntry).timestamp === "number"
  );
}

/** Reads the saved prompt history for this connection+namespace, most recent first — empty if none
 * was ever saved, or if storage is unavailable/corrupted. */
export function loadPromptHistory(connectionId: string, namespace: string): PromptHistoryEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(connectionId, namespace));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPromptHistoryEntry) : [];
  } catch {
    return [];
  }
}

function persist(connectionId: string, namespace: string, entries: PromptHistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(connectionId, namespace), JSON.stringify(entries));
  } catch {
    // Storage full or unavailable — losing prompt history isn't worth surfacing to the user.
  }
}

/** Prepends the prompt and caps the saved list at MAX_ENTRIES (oldest falls off) — returns the
 * updated list so the caller can put it straight into state without a separate load. `sessionId`
 * is the chat this prompt continues, when already known (i.e. not the first prompt of a new chat —
 * see tagLatestPromptHistoryEntry for that case). */
export function addPromptHistoryEntry(
  connectionId: string,
  namespace: string,
  prompt: string,
  sessionId?: string,
): PromptHistoryEntry[] {
  const trimmed = prompt.trim();
  if (!trimmed) return loadPromptHistory(connectionId, namespace);
  const next = [
    { prompt: trimmed, timestamp: Date.now(), sessionId },
    ...loadPromptHistory(connectionId, namespace),
  ].slice(0, MAX_ENTRIES);
  persist(connectionId, namespace, next);
  return next;
}

/** Backfills the session id onto the most recent entry once it becomes known — used when a prompt
 * starts a brand-new chat, so its session id isn't known until opencode's first response streams
 * in, after the entry was already saved. No-ops if that entry was already tagged (e.g. a second
 * event carrying the same session id arrives). Returns the updated list, or null if there was
 * nothing to tag. */
export function tagLatestPromptHistoryEntry(
  connectionId: string,
  namespace: string,
  sessionId: string,
): PromptHistoryEntry[] | null {
  const entries = loadPromptHistory(connectionId, namespace);
  if (entries.length === 0 || entries[0].sessionId) return null;
  const next = [{ ...entries[0], sessionId }, ...entries.slice(1)];
  persist(connectionId, namespace, next);
  return next;
}

export function clearPromptHistory(connectionId: string, namespace: string): void {
  try {
    localStorage.removeItem(storageKey(connectionId, namespace));
  } catch {
    // Nothing to do if storage isn't available.
  }
}
