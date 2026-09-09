// Remembers which opencode session (`ses_...`) is the "current chat" for a connection+namespace,
// so the next prompt continues it instead of opencode silently starting a new one every time (see
// agentRun.ts's `--session` handling). Mirrors themePreference.ts's localStorage pattern — absent
// just means the next prompt starts a fresh chat.
function storageKey(connectionId: string, namespace: string): string {
  return `typer.agent-session::${connectionId}::${namespace}`;
}

export function loadActiveSessionId(connectionId: string, namespace: string): string | null {
  try {
    return localStorage.getItem(storageKey(connectionId, namespace));
  } catch {
    return null;
  }
}

export function saveActiveSessionId(
  connectionId: string,
  namespace: string,
  sessionId: string,
): void {
  try {
    localStorage.setItem(storageKey(connectionId, namespace), sessionId);
  } catch {
    // Storage full/unavailable — worst case the next prompt starts a new chat instead of continuing.
  }
}

export function clearActiveSessionId(connectionId: string, namespace: string): void {
  try {
    localStorage.removeItem(storageKey(connectionId, namespace));
  } catch {
    // Nothing to do if storage isn't available.
  }
}
