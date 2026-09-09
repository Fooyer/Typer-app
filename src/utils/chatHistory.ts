// Persists the actual conversation (user prompts + assistant replies) per connection+namespace,
// so closing and reopening the agent tab — or restarting the app — restores the chat instead of
// resetting to a blank transcript. This complements promptHistory.ts (which only remembers the
// *prompts* for quick re-send) by remembering the *whole* back-and-forth, including the agent's
// answers, which were previously lost the moment the tab closed.
//
// Only chat content is stored here (user prompts and assistant markdown/tool summary). No server
// data is ever persisted — the text is whatever was exchanged in the chat itself, never a document
// or query result fetched from IRIS.

export interface ChatToolEvent {
  tool: string;
  title?: string;
  status?: string;
  diff?: string;
  input?: unknown;
  /** Set when the tool call itself failed (see agentTranscript.ts) — shown as an inline alert. */
  errorText?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /** assistant-only — the tool calls made while producing this reply, in order. */
  tools?: ChatToolEvent[];
  /** assistant-only — a structured error for this reply (e.g. the run died on a token limit). */
  error?: string;
  /** assistant-only — the model's accumulated reasoning/thinking trail for this reply, if the run
   * streamed any (see agentTranscript.ts's "reasoning" kind). Kept so it's still there to expand
   * after the run moves on, not just flashed in the activity line while it's happening. */
  reasoning?: string;
  /** assistant-only — true while the current run is still streaming this reply into view. */
  running?: boolean;
}

const MAX_MESSAGES = 200;

function storageKey(connectionId: string, namespace: string): string {
  return `typer.agent-chat::${connectionId}::${namespace}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as ChatMessage;
  return (
    (msg.role === "user" || msg.role === "assistant") &&
    typeof msg.text === "string" &&
    typeof msg.id === "string" &&
    typeof msg.timestamp === "number"
  );
}

/** Reads the saved conversation for this connection+namespace, oldest first (chronological order
 * so `[...saved, newMessage]` appends naturally at the bottom). */
export function loadChatHistory(connectionId: string, namespace: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(connectionId, namespace));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isChatMessage) : [];
  } catch {
    return [];
  }
}

/** Overwrites the persisted conversation for this connection+namespace. Cap is enforced here, not
 * only at append time, so a caller that stitches messages together still stays within bounds. */
export function persistChatHistory(
  connectionId: string,
  namespace: string,
  messages: ChatMessage[],
): void {
  try {
    localStorage.setItem(
      storageKey(connectionId, namespace),
      JSON.stringify(messages.slice(-MAX_MESSAGES)),
    );
  } catch {
    // Storage full or unavailable — losing chat history isn't worth surfacing to the user.
  }
}

export function clearChatHistory(connectionId: string, namespace: string): void {
  try {
    localStorage.removeItem(storageKey(connectionId, namespace));
  } catch {
    // Nothing to do if storage isn't available.
  }
}

/** A past conversation, archived when the user starts a new chat (see AgentPanel.tsx's
 * `startNewChat`/`archiveActiveChat`) — this is what backs the "Chats" tab, letting the user come
 * back to and continue an earlier conversation instead of it being discarded the moment a new one
 * starts. `sessionId` is opencode's own id for that conversation, so re-opening one and sending
 * another prompt continues it rather than starting yet another fresh session. */
export interface ChatSession {
  id: string;
  /** Derived from the first user message (truncated) — just a label for the list, not edited. */
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  messages: ChatMessage[];
}

const MAX_SESSIONS = 50;

function sessionsKey(connectionId: string, namespace: string): string {
  return `typer.agent-chat-sessions::${connectionId}::${namespace}`;
}

function isChatSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== "object") return false;
  const session = value as ChatSession;
  return (
    typeof session.id === "string" &&
    typeof session.title === "string" &&
    typeof session.createdAt === "number" &&
    Array.isArray(session.messages)
  );
}

/** Newest first — matches how a chat list is expected to read. */
export function loadChatSessions(connectionId: string, namespace: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(sessionsKey(connectionId, namespace));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isChatSession) : [];
  } catch {
    return [];
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((m) => m.role === "user")?.text.trim();
  if (!firstUserMessage) return "Conversa sem título";
  return firstUserMessage.length > 60 ? `${firstUserMessage.slice(0, 60)}…` : firstUserMessage;
}

/** Archives one finished/left-behind conversation into the list — called right before a chat's
 * messages get cleared (new chat, or switching to a different archived one), never on an empty
 * conversation (nothing worth keeping a slot for). */
export function archiveChatSession(
  connectionId: string,
  namespace: string,
  messages: ChatMessage[],
  sessionId: string | null,
): void {
  if (messages.length === 0) return;
  const sessions = loadChatSessions(connectionId, namespace);
  const now = Date.now();
  const session: ChatSession = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: deriveTitle(messages),
    createdAt: messages[0]?.timestamp ?? now,
    updatedAt: now,
    sessionId,
    messages,
  };
  try {
    localStorage.setItem(
      sessionsKey(connectionId, namespace),
      JSON.stringify([...sessions, session].slice(-MAX_SESSIONS)),
    );
  } catch {
    // Storage full or unavailable — losing the archived chat isn't worth surfacing to the user.
  }
}

export function deleteChatSession(connectionId: string, namespace: string, sessionId: string): void {
  const sessions = loadChatSessions(connectionId, namespace).filter((s) => s.id !== sessionId);
  try {
    localStorage.setItem(sessionsKey(connectionId, namespace), JSON.stringify(sessions));
  } catch {
    // Nothing to do if storage isn't available.
  }
}
