import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseAgentLine, toolIcon } from "../utils/agentTranscript";
import {
  loadChatHistory,
  persistChatHistory,
  clearChatHistory,
  loadChatSessions,
  archiveChatSession,
  deleteChatSession,
  type ChatMessage,
  type ChatToolEvent,
  type ChatSession,
} from "../utils/chatHistory";
import { renderMarkdown } from "../utils/markdown";
import {
  clearActiveSessionId,
  loadActiveSessionId,
  saveActiveSessionId,
} from "../utils/agentSession";
import { loadAiPreference, onAiPreferenceChange, AI_PROVIDERS } from "../utils/aiPreference";
import { loadSpecsDirOverride } from "../utils/specsPreference";
import type { LogLevel } from "./OutputPanel";

interface AgentPanelProps {
  connectionId: string;
  namespace: string;
  onLog: (message: string, level?: LogLevel) => void;
  /** Called after a pending write is approved AND actually lands on the server (not just clicked
   * "approve" — a compile failure after approval does not fire this), so the caller can refresh
   * the file explorer and reload any open tab for that document without the user having to do it
   * by hand. */
  onDocumentSaved?: (connectionId: string, namespace: string, docName: string) => void;
}

interface PendingWriteItem {
  pendingId: string;
  name: string;
  patch: string;
}

interface HistoryEntry {
  name: string;
  patch: string;
  /** "failed" is approved-but-not-saved (e.g. a compile error after the user said yes) — kept
   * distinct from "approved" so the history doesn't show a green checkmark for a change that
   * never actually landed on the server. */
  status: "approved" | "discarded" | "failed";
}

interface ReviewBatch {
  id: string;
  prompt: string;
  entries: HistoryEntry[];
}

type ReviewRow =
  | { key: string; kind: "batch"; prompt: string }
  | { key: string; kind: "entry"; entryKey: string; entry: HistoryEntry };

// Fixed row heights make the history list virtualizable with simple arithmetic instead of
// measuring real DOM nodes — an expanded entry doesn't grow to fit its diff, the diff itself
// scrolls internally at a fixed height (see .agent-panel-diff-entry-row .agent-panel-diff-patch),
// so every row's height is always one of exactly two known values.
const BATCH_ROW_HEIGHT = 30;
const ENTRY_ROW_HEIGHT = 28;
const ENTRY_DIFF_HEIGHT = 280;
const REVIEW_OVERSCAN = 6;

// If nothing has come from the agent in this long while it's still marked "running", opencode has
// likely wedged (or crashed without opencode itself noticing) rather than genuinely still thinking
// — long enough to not false-positive on a slow bash/webfetch call, short enough to not leave the
// user staring at a silent spinner for minutes wondering if anything is happening.
const STALL_MS = 60_000;
// Also drives the elapsed-time counters shown throughout the activity indicators below — 1s
// keeps those actually reading as a live ticking clock instead of visibly jumping in 2s steps.
const STALL_CHECK_INTERVAL_MS = 1_000;
// Belt-and-suspenders on top of the soft warning above: since only one agent can run at a time
// (see agent_run.rs), a run that's truly wedged and goes unnoticed would otherwise lock the whole
// panel out of ever starting another prompt. Past this much *total* silence, abort it
// automatically instead of waiting on the user to notice and click "Parar" themselves.
const HARD_STALL_MS = 5 * 60_000;

/** Computes just the new suffix of a part's full-text-so-far against what was last seen for that
 * same part id — see the `lastTextByPartRef`/`lastReasoningByPartRef` doc comment for why this is
 * needed at all. Falls back to emitting the whole new text as the "delta" when it doesn't cleanly
 * extend the previous one (a genuinely new/reset part), rather than trying to diff mismatched
 * strings. */
function nextDelta(byId: Map<string, string>, id: string, full: string): string {
  const prev = byId.get(id) ?? "";
  byId.set(id, full);
  if (full.length > prev.length && full.startsWith(prev)) return full.slice(prev.length);
  if (full && full !== prev) return full;
  return "";
}

function reviewRowHeight(row: ReviewRow, expanded: Set<string>): number {
  if (row.kind === "batch") return BATCH_ROW_HEIGHT;
  return ENTRY_ROW_HEIGHT + (expanded.has(row.entryKey) ? ENTRY_DIFF_HEIGHT : 0);
}

function renderDiffLines(patch: string) {
  return patch.split("\n").map((line, index) => {
    const className =
      line.startsWith("+") && !line.startsWith("+++")
        ? "diff-add"
        : line.startsWith("-") && !line.startsWith("---")
          ? "diff-del"
          : line.startsWith("@@")
            ? "diff-hunk"
            : undefined;
    return (
      <div key={index} className={className}>
        {line || " "}
      </div>
    );
  });
}

// A dedicated component (rather than parsing inline in the transcript's .map) so React can key off
// the `text` prop and skip re-parsing a message that already streamed in once a *later* message
// arrives and re-renders the list — opencode's replies are markdown, and rendering the raw string
// showed the literal `**`/`#`/backtick syntax instead of formatted text.
// `cursor` appends the blinking caret straight into the markdown SOURCE (rather than as a sibling
// element after the rendered HTML) so it flows as real inline content right after the last
// character written so far — a sibling would only ever sit at a fixed spot below/beside the
// rendered block, not actually at the end of a possibly multi-line, multi-paragraph reply.
function AgentMarkdown({ text, cursor }: { text: string; cursor?: boolean }) {
  const source = cursor ? `${text}<span class="agent-msg-typing"> </span>` : text;
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className="agent-msg-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// One collapsible tool call rendered inside an assistant message — same content as the old flat
// transcript showed, just grouped under the reply that made the call.
function ToolCard({ tool }: { tool: ChatToolEvent }) {
  const failed = tool.errorText !== undefined;
  const isTask = tool.tool.toLowerCase() === "task";
  const inProgress = tool.status === "running" || tool.status === "pending";
  return (
    <details
      className={`agent-msg-tool${failed ? " agent-msg-tool-failed" : ""}${isTask ? " agent-msg-tool-task" : ""}`}
      // Auto-expanded on failure or while still running (so a sub-agent delegation — or any other
      // slow tool call — actually shows its input/progress instead of sitting collapsed looking
      // idle) and always for a "task" call, since seeing what got delegated (and to what result)
      // is the whole point of showing it at all.
      open={failed || inProgress || isTask}
    >
      <summary>
        <span className="agent-tool-icon">{failed ? "⚠️" : toolIcon(tool.tool)}</span>
        <span className="agent-tool-name">{isTask ? "Sub-agente" : tool.tool}</span>
        {tool.title && <span className="agent-tool-title">{tool.title}</span>}
        {inProgress && <span className="agent-tool-running-spinner" aria-hidden="true" />}
      </summary>
      {failed && <div className="agent-tool-error">{tool.errorText}</div>}
      {tool.diff ? (
        <div className="agent-panel-diff-patch">{renderDiffLines(tool.diff)}</div>
      ) : (
        tool.input !== undefined && (
          <pre className="agent-tool-input">{JSON.stringify(tool.input, null, 2)}</pre>
        )
      )}
    </details>
  );
}

function AgentPanel({ connectionId, namespace, onLog, onDocumentSaved }: AgentPanelProps) {
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState("");
  // The conversation itself (user + assistant messages), chronological order — persisted per
  // connection+namespace (see chatHistory.ts) so closing/reopening this tab (or restarting the
  // app) restores the whole chat, not just the prompts.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadChatHistory(connectionId, namespace),
  );
  // Transient stderr/raw noise from the live run, cleared on every new prompt — kept out of the
  // persisted conversation because it's diagnostic noise, not part of the back-and-forth.
  const [liveNotes, setLiveNotes] = useState<{ text: string; stderr: boolean }[]>([]);
  const [pendingWrites, setPendingWrites] = useState<PendingWriteItem[]>([]);
  const [reviews, setReviews] = useState<ReviewBatch[]>([]);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => new Set());
  const [reviewScrollTop, setReviewScrollTop] = useState(0);
  const [reviewViewportHeight, setReviewViewportHeight] = useState(0);
  // The opencode chat this AgentPanel is currently continuing — null means the next prompt starts a
  // brand-new one. Persisted (see agentSession.ts) so it survives closing/reopening this tab.
  const [sessionId, setSessionId] = useState<string | null>(() =>
    loadActiveSessionId(connectionId, namespace),
  );
  // Which provider/model the agent will run with — from the non-secret renderer preference
  // (the API key itself lives in the main process; see aiPreference.ts / aiSettings.ts). Refreshed
  // on every save (not just read once at mount) — this panel is typically already mounted when the
  // user opens Settings and changes the provider, and a stale value here would keep showing (and
  // running with) whatever was current when the tab first opened.
  const [aiPreference, setAiPreference] = useState(() => loadAiPreference());
  useEffect(() => onAiPreferenceChange(setAiPreference), []);
  // The rail's two drawers (code changes the agent proposed, and past chats) — the chat itself
  // stays on the left; this right-side rail only claims width while one is open. At most one open
  // at a time, like tabs.
  const [railTab, setRailTab] = useState<"changes" | "chats" | null>(null);
  const changesOpen = railTab === "changes";
  // Archived past conversations for this connection+namespace (see chatHistory.ts) — reloaded
  // whenever one gets archived (a new chat starts, or the user switches to another past one) so
  // the "Chats" tab always reflects what's actually on disk.
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(() =>
    loadChatSessions(connectionId, namespace),
  );
  // Bumped every stall-check tick purely to force a re-render so the elapsed-time readout in the
  // activity indicator (which reads Date.now() - lastActivityRef.current directly, not state)
  // actually ticks live instead of freezing at whatever it said on the last real event.
  const [, setTick] = useState(0);
  // True once STALL_MS has passed since the last event with nothing new arriving — the run still
  // says "running" (opencode's process hasn't exited), but nothing suggests it's actually doing
  // anything anymore. See the stall-watch effect below.
  const [stalled, setStalled] = useState(false);
  // Live snippet of whatever reasoning text is streaming in right now — reasoning is only ever used
  // to drive the "Pensando…" loader below, never kept in the conversation, since the full text is
  // just noise once the run has moved on (see the loader-building code near the bottom of this file).
  const [reasoningSnippet, setReasoningSnippet] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const currentBatchRef = useRef<{ id: string; prompt: string } | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const messageSeqRef = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);
  // Whether the chat should keep auto-scrolling to the bottom as new content streams in. Defaults
  // to true, and flips to false the moment the user scrolls up — so streaming text never yanks
  // them back down; scrolling back to the bottom re-engages follow mode (see handleChatScroll).
  const stickToBottomRef = useRef(true);
  const lastActivityRef = useRef<number>(Date.now());
  // What the last event was doing, for the "what's the agent doing right now" loader — separate
  // from the stall timer's lastActivityRef.
  const streamKindRef = useRef<"tool" | "text" | null>(null);
  const lastToolLabelRef = useRef<string | null>(null);
  const lastToolNameRef = useRef<string | null>(null);
  // opencode resends the FULL running text for a given part id on every line, not just the newest
  // chunk (confirmed against a working sibling project's integration) — these track the last-seen
  // full text per part id so only the new suffix gets appended, instead of re-appending the whole
  // growing string on every single event.
  const lastTextByPartRef = useRef<Map<string, string>>(new Map());
  const lastReasoningByPartRef = useRef<Map<string, string>>(new Map());
  // Guards the auto-abort below from firing more than once per run — the stall check re-evaluates
  // every STALL_CHECK_INTERVAL_MS, and without this it would call abort() repeatedly for as long
  // as the (already-cancelled) run takes to actually exit.
  const hardStallTriggeredRef = useRef(false);
  // Tracks whether the current run ever showed an explicit error line — read from `onDone` (not
  // React state, since that handler is registered once with an empty dep array and would otherwise
  // see a stale closure) to tell a clean-but-silent process death from a run that already
  // explained itself.
  const sawErrorRef = useRef(false);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  const aiLabel = useMemo(() => {
    if (aiPreference.providerId === "default" && !aiPreference.model) return null;
    const provider = AI_PROVIDERS.find((p) => p.id === aiPreference.providerId);
    const name = provider?.label ?? aiPreference.providerId;
    return aiPreference.model ? `${name} · ${aiPreference.model}` : name;
  }, [aiPreference]);

  // Keeps the ref scribed to the latest committed value so the once-registered IPC handlers never
  // read stale closures (they can't re-subscribe, since each run can race a React re-render). Every
  // mutation also writes the ref directly (see applyMessages), so this is just a safety net.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Single write-through helper: updates both the ref (events + handlers) and React state, and
   * persists the new tail to localStorage. */
  const applyMessages = (next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    persistChatHistory(connectionId, namespace, next);
  };

  function nextMessageId(): string {
    messageSeqRef.current += 1;
    return `${Date.now()}-${messageSeqRef.current}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function findRunningAssistantIndex(msgs: ChatMessage[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].running) return i;
    }
    return -1;
  }

  function ensureRunningAssistant(): string {
    const idx = findRunningAssistantIndex(messagesRef.current);
    if (idx !== -1) return messagesRef.current[idx].id;
    const next: ChatMessage[] = [
      ...messagesRef.current,
      { id: nextMessageId(), role: "assistant", text: "", timestamp: Date.now(), running: true },
    ];
    applyMessages(next);
    return next[next.length - 1].id;
  }

  function appendAssistantText(text: string): void {
    const id = ensureRunningAssistant();
    applyMessages(
      messagesRef.current.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)),
    );
  }

  function appendAssistantReasoning(text: string): void {
    const id = ensureRunningAssistant();
    applyMessages(
      messagesRef.current.map((m) =>
        m.id === id ? { ...m, reasoning: (m.reasoning ?? "") + text } : m,
      ),
    );
  }

  function appendAssistantTool(tool: ChatToolEvent): void {
    const id = ensureRunningAssistant();
    applyMessages(
      messagesRef.current.map((m) =>
        m.id === id ? { ...m, tools: [...(m.tools ?? []), tool] } : m,
      ),
    );
  }

  function setAssistantError(text: string): void {
    const id = ensureRunningAssistant();
    applyMessages(
      messagesRef.current.map((m) => (m.id === id ? { ...m, error: text, running: false } : m)),
    );
  }

  function finishRunningAssistant(): void {
    const idx = findRunningAssistantIndex(messagesRef.current);
    if (idx === -1) return;
    applyMessages(messagesRef.current.map((m, i) => (i === idx ? { ...m, running: false } : m)));
  }

  useEffect(() => {
    if (!hasElectronAPI) return;
    const offEvent = window.electronAPI.agent.onEvent((payload) => {
      if (payload.runId !== runIdRef.current) return;
      lastActivityRef.current = Date.now();
      setStalled(false);
      const item = parseAgentLine(payload.line);
      if (!item) return;

      if (item.kind === "reasoning") {
        const delta = nextDelta(lastReasoningByPartRef.current, item.id, item.text);
        if (delta) appendAssistantReasoning(delta);
        setReasoningSnippet(item.text.trim());
        return;
      }
      setReasoningSnippet(null);
      if (item.kind === "error") {
        sawErrorRef.current = true;
        setAssistantError(item.text);
        return;
      }
      if (item.kind === "text") {
        streamKindRef.current = "text";
        const delta = nextDelta(lastTextByPartRef.current, item.id, item.text);
        if (delta) appendAssistantText(delta);
        return;
      }
      if (item.kind === "tool") {
        streamKindRef.current = "tool";
        lastToolLabelRef.current = item.title ?? item.tool;
        lastToolNameRef.current = item.tool;
        appendAssistantTool({
          tool: item.tool,
          title: item.title,
          status: item.status,
          diff: item.diff,
          input: item.input,
          errorText: item.errorText,
        });
        return;
      }
      // Anything not matched above is diagnostic noise (non-JSON stderr lines, raw events) — keep
      // it visible during the run for debugging but out of the saved conversation.
      setLiveNotes((prev) => [...prev, { text: item.text, stderr: !!payload.stderr }]);
    });
    const offDone = window.electronAPI.agent.onDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      // A nonzero exit that never showed an explicit error line usually means the process died
      // quietly rather than opencode reporting why — for a big prompt, the single most likely cause
      // is the session running out of the model's token/context budget mid-generation. Surfacing a
      // guess beats leaving the user staring at a transcript that just... stops.
      if (payload.code !== 0 && !sawErrorRef.current) {
        setAssistantError(
          `O agente encerrou inesperadamente (código ${payload.code}) sem explicar o motivo. ` +
            `Isso costuma acontecer quando a sessão atinge o limite de tokens/contexto do modelo. ` +
            `Inicie um Novo Chat para continuar.`,
        );
      }
      finishRunningAssistant();
      setRunning(false);
      setStalled(false);
      setReasoningSnippet(null);
      setLiveNotes([]);
      setPendingWrites([]);
      streamKindRef.current = null;
      lastToolLabelRef.current = null;
      lastToolNameRef.current = null;
      onLog(
        payload.code === 0 ? "Agente terminou." : `Agente terminou com código ${payload.code}.`,
        payload.code === 0 ? "success" : "error",
      );
    });
    const offPending = window.electronAPI.agent.onPendingWrite((payload) => {
      if (payload.runId !== runIdRef.current) return;
      lastActivityRef.current = Date.now();
      setStalled(false);
      setPendingWrites((prev) => [
        ...prev,
        { pendingId: payload.pendingId, name: payload.name, patch: payload.patch },
      ]);
    });
    // Fires once per run, as soon as opencode's first output line reveals which session it's using
    // (a brand-new one if this run didn't pass `--session`) — see agentRun.ts. Persisting it here
    // means the *next* prompt continues this same chat instead of opencode starting another one.
    const offSession = window.electronAPI.agent.onSession((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setSessionId(payload.sessionId);
      saveActiveSessionId(connectionId, namespace, payload.sessionId);
    });
    return () => {
      offEvent();
      offDone();
      offPending();
      offSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polls rather than a single setTimeout so it keeps re-checking against the latest
  // lastActivityRef instead of needing to be reset/rescheduled on every single event.
  useEffect(() => {
    if (!running) {
      setStalled(false);
      return;
    }
    const interval = setInterval(() => {
      const silentFor = Date.now() - lastActivityRef.current;
      setStalled(silentFor > STALL_MS);
      setTick((t) => t + 1);
      if (silentFor > HARD_STALL_MS && !hardStallTriggeredRef.current) {
        hardStallTriggeredRef.current = true;
        setError(
          `O agente foi interrompido automaticamente após ${Math.round(HARD_STALL_MS / 60_000)} ` +
            `minutos sem nenhuma resposta, provavelmente travou. Tente de novo ou, se persistir, ` +
            `reinicie o app.`,
        );
        void abort();
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running]);

  useEffect(() => {
    // Only follows the stream while the user is at or near the bottom — scrolling up suspends
    // auto-follow until they scroll back down (see handleChatScroll) or start a new prompt.
    if (!stickToBottomRef.current) return;
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages, liveNotes]);

  useEffect(() => {
    if (!changesOpen) return;
    reviewListRef.current?.scrollTo({ top: reviewListRef.current.scrollHeight });
  }, [reviews, changesOpen]);

  // Re-measures (and re-observes) whenever the drawer opens — it's unmounted while closed, so the
  // ref is null until then and an observer set up only once on mount would never find it.
  useLayoutEffect(() => {
    if (!changesOpen) return;
    const el = reviewListRef.current;
    if (!el) return;
    setReviewViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) =>
      setReviewViewportHeight(entry.contentRect.height),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [changesOpen]);

  const handleReviewScroll = useCallback(() => {
    setReviewScrollTop(reviewListRef.current?.scrollTop ?? 0);
  }, []);

  // If the user is within ~1 line-height of the bottom they're "following"; scrolling any further
  // up releases follow mode so incoming text never teleports them back down. Scrolling back to
  // the bottom re-engages follow mode (and sending a prompt does too — see runPrompt).
  const handleChatScroll = useCallback(() => {
    const el = chatRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  function toggleEntryExpanded(entryKey: string) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryKey)) next.delete(entryKey);
      else next.add(entryKey);
      return next;
    });
  }

  const reviewRows = useMemo<ReviewRow[]>(() => {
    const out: ReviewRow[] = [];
    for (const batch of reviews) {
      out.push({ key: `batch:${batch.id}`, kind: "batch", prompt: batch.prompt });
      batch.entries.forEach((entry, index) => {
        out.push({
          key: `entry:${batch.id}:${index}`,
          kind: "entry",
          entryKey: `${batch.id}:${index}`,
          entry,
        });
      });
    }
    return out;
  }, [reviews]);

  const reviewOffsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const row of reviewRows) {
      out.push(acc);
      acc += reviewRowHeight(row, expandedEntries);
    }
    out.push(acc);
    return out;
  }, [reviewRows, expandedEntries]);

  const reviewTotalHeight = reviewOffsets[reviewOffsets.length - 1] ?? 0;

  let reviewStartIndex = 0;
  while (
    reviewStartIndex < reviewRows.length &&
    reviewOffsets[reviewStartIndex + 1] <= reviewScrollTop
  )
    reviewStartIndex++;
  reviewStartIndex = Math.max(0, reviewStartIndex - REVIEW_OVERSCAN);
  let reviewEndIndex = reviewStartIndex;
  while (
    reviewEndIndex < reviewRows.length &&
    reviewOffsets[reviewEndIndex] < reviewScrollTop + reviewViewportHeight
  )
    reviewEndIndex++;
  reviewEndIndex = Math.min(reviewRows.length, reviewEndIndex + REVIEW_OVERSCAN);
  const visibleReviewRows = reviewRows.slice(reviewStartIndex, reviewEndIndex);

  async function runPrompt() {
    const submitted = prompt.trim();
    if (!submitted || running) return;
    currentBatchRef.current = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt: submitted,
    };
    // The user's message is part of the saved conversation (oldest-first order, appended at the
    // bottom, so the next run's assistant reply lands right after it).
    applyMessages([
      ...messagesRef.current,
      { id: nextMessageId(), role: "user", text: submitted, timestamp: Date.now() },
    ]);
    setLiveNotes([]);
    setReasoningSnippet(null);
    setError(null);
    setRunning(true);
    stickToBottomRef.current = true; // follow the new reply from the bottom
    setStalled(false);
    sawErrorRef.current = false;
    streamKindRef.current = null;
    lastToolLabelRef.current = null;
    lastActivityRef.current = Date.now();
    lastTextByPartRef.current.clear();
    lastReasoningByPartRef.current.clear();
    hardStallTriggeredRef.current = false;
    try {
      const specsDir = await window.electronAPI.specs.resolveDir(
        connectionId,
        namespace,
        loadSpecsDirOverride(connectionId, namespace),
      );
      runIdRef.current = await window.electronAPI.agent.run(
        connectionId,
        namespace,
        submitted,
        specsDir,
        undefined,
        sessionId ?? undefined,
      );
      setPrompt("");
    } catch (err) {
      const message = `Erro ao iniciar o agente: ${(err as Error).message}`;
      setError(message);
      onLog(message, "error");
      // Make sure no half-open assistant message is left dangling as "running" forever.
      finishRunningAssistant();
      setRunning(false);
    }
  }

  // Recovers from the "one agent at a time" lock (see agent_run.rs) when this panel has no runId
  // left to call the normal abort() with — a reload or crash can leave the backend still holding
  // the lock for a run the frontend no longer remembers starting.
  async function forceResetLock() {
    try {
      await window.electronAPI.agent.forceReset();
      setError(null);
      setRunning(false);
      finishRunningAssistant();
      onLog("Trava de execução do agente liberada manualmente.", "info");
    } catch (err) {
      setError(`Erro ao forçar a liberação: ${(err as Error).message}`);
    }
  }

  // Starts a fresh chat: opencode gets no `--session` on the next run, so it creates a new one
  // instead of continuing this one. Clears the saved conversation too (a new chat starts clean);
  // the 50-entry prompt Histórico still keeps this chat's prompts, just visually separated (see
  // the divider in the Histórico drawer) from whatever comes next.
  /** Saves the current conversation into the "Chats" list before it's about to be replaced (a new
   * chat starting, or switching to a different past one) — a no-op if it's already empty, so
   * starting fresh from a blank chat never litters the list with empty entries. */
  function archiveCurrentChat() {
    if (messagesRef.current.length === 0) return;
    archiveChatSession(connectionId, namespace, messagesRef.current, sessionId);
    setChatSessions(loadChatSessions(connectionId, namespace));
  }

  function startNewChat() {
    archiveCurrentChat();
    clearActiveSessionId(connectionId, namespace);
    clearChatHistory(connectionId, namespace);
    setSessionId(null);
    setMessages([]);
    messagesRef.current = [];
    setLiveNotes([]);
    setReviews([]);
    setPendingWrites([]);
    setError(null);
    setReasoningSnippet(null);
  }

  /** Brings an archived chat back as the active one (so its next prompt continues that same
   * opencode session), archiving whatever was active first so nothing gets lost either way. */
  function openChatSession(target: ChatSession) {
    if (running) return;
    archiveCurrentChat();
    deleteChatSession(connectionId, namespace, target.id);
    setChatSessions(loadChatSessions(connectionId, namespace));
    setMessages(target.messages);
    messagesRef.current = target.messages;
    persistChatHistory(connectionId, namespace, target.messages);
    setSessionId(target.sessionId);
    if (target.sessionId) saveActiveSessionId(connectionId, namespace, target.sessionId);
    else clearActiveSessionId(connectionId, namespace);
    setRailTab(null);
    stickToBottomRef.current = true; // start at the bottom of the restored conversation
  }

  function removeChatSession(id: string) {
    deleteChatSession(connectionId, namespace, id);
    setChatSessions(loadChatSessions(connectionId, namespace));
  }

  async function abort() {
    if (!runIdRef.current) return;
    try {
      await window.electronAPI.agent.abort(runIdRef.current);
    } catch (err) {
      setError(`Erro ao parar o agente: ${(err as Error).message}`);
    }
  }

  // Optimistic: the dialog closes (item removed from the queue) the instant the user clicks,
  // instead of waiting on the save/compile round trip — the actual write still happens and its
  // outcome is reported via onLog (and reflected in history) once it resolves, in the background.
  function resolvePending(pendingId: string, approved: boolean) {
    const item = pendingWrites.find((entry) => entry.pendingId === pendingId);
    if (!item) return;
    setPendingWrites((prev) => prev.filter((entry) => entry.pendingId !== pendingId));
    setResolvingIds((prev) => new Set(prev).add(pendingId));
    void (async () => {
      try {
        const result = await window.electronAPI.agent.resolvePendingWrite(pendingId, approved);
        const saved = approved && !!result?.saved;
        if (saved) {
          onLog(`${item.name}: aprovado e salvo no servidor.`, "success");
          result?.compileOutput?.forEach((line) => onLog(line, "info"));
          onDocumentSaved?.(connectionId, namespace, item.name);
        } else if (approved) {
          // The user said yes but the write didn't land — surface why instead of the generic
          // success message, so a compile failure doesn't look like it silently worked.
          onLog(
            `${item.name}: aprovado, mas falhou ao salvar no servidor: ${result?.error ?? "erro desconhecido"}.`,
            "error",
          );
        } else {
          onLog(`${item.name}: rejeitado.`, "info");
        }
        const batch = currentBatchRef.current;
        if (batch) {
          const historyEntry: HistoryEntry = {
            name: item.name,
            patch: item.patch,
            status: approved ? (saved ? "approved" : "failed") : "discarded",
          };
          setReviews((prev) => {
            const existing = prev.find((b) => b.id === batch.id);
            if (existing) {
              return prev.map((b) =>
                b.id === batch.id ? { ...b, entries: [...b.entries, historyEntry] } : b,
              );
            }
            return [...prev, { id: batch.id, prompt: batch.prompt, entries: [historyEntry] }];
          });
        }
      } catch (err) {
        onLog(
          `Erro ao ${approved ? "aprovar" : "rejeitar"} ${item.name}: ${(err as Error).message}`,
          "error",
        );
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev);
          next.delete(pendingId);
          return next;
        });
      }
    })();
  }

  if (!hasElectronAPI) {
    return (
      <div className="agent-panel">
        <p className="connection-status">Disponível apenas rodando no app desktop.</p>
      </div>
    );
  }

  const activeReview = pendingWrites[0] ?? null;
  // Live because the stall-check interval bumps `tick` every 2s while running (see that effect) —
  // this recomputes on every one of those forced re-renders, not just when a real event arrives,
  // which is what makes it actually count up instead of freezing. Shown on EVERY activity line
  // below, not just the sub-agent one — a ticking number is what actually reads as "still alive"
  // during a stretch where the model is silently generating and nothing new has arrived to show.
  const elapsedSinceActivity = Math.max(0, Math.round((Date.now() - lastActivityRef.current) / 1000));

  // What to show in the loader while running: the review dialog already makes clear the agent is
  // waiting on a human, so there's nothing useful to add there. Otherwise, describe whatever the
  // last event was — the tool it's currently running, or that it's writing a reply — and fall back
  // to "thinking" before the first event of a run has even arrived.
  const currentActivity =
    running && !activeReview
      ? (() => {
          if (reasoningSnippet) {
            const tail = reasoningSnippet.slice(-80);
            return `💭 ${tail}${reasoningSnippet.length > 80 ? "…" : ""} (${elapsedSinceActivity}s)`;
          }
          if (streamKindRef.current === "tool" && lastToolLabelRef.current) {
            return `${toolIcon(lastToolNameRef.current ?? lastToolLabelRef.current)} ${lastToolLabelRef.current} (${elapsedSinceActivity}s)`;
          }
          if (streamKindRef.current === "text") return `💬 Escrevendo resposta… (${elapsedSinceActivity}s)`;
          return `Pensando… (${elapsedSinceActivity}s)`;
        })()
      : null;

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <span className="agent-panel-namespace">🤖 {namespace}</span>
        {aiLabel && (
          <span className="agent-panel-model-badge" title="Modelo configurado">
            {aiLabel}
          </span>
        )}
        <button
          type="button"
          className="agent-panel-new-chat-button"
          onClick={startNewChat}
          disabled={running || (!sessionId && messages.length === 0)}
          title="Encerrar este chat e começar um novo (o próximo prompt não continua a conversa atual)"
        >
          🆕 Novo Chat
        </button>
        {resolvingIds.size > 0 && (
          <span className="agent-panel-saving-badge">
            <span className="agent-panel-saving-spinner" />
            Salvando {resolvingIds.size} alteração(ões)…
          </span>
        )}
      </div>

      {error && (
        <div className="agent-panel-error">
          <span>⚠ {error}</span>
          {error.includes("Só um agente pode rodar por vez") && !running && (
            <button type="button" className="agent-panel-secondary" onClick={forceResetLock}>
              Forçar liberação
            </button>
          )}
          <button type="button" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="agent-panel-body">
        {/* DOM order is rail-then-main, but flex `order` in style.css draws the rail on the right
          and the chat column on the left, like an agent-first IDE's side panel. */}
        <div className="agent-panel-history-rail">
          <div className="agent-panel-history-tabstrip">
            <button
              type="button"
              className={`agent-panel-history-tab${changesOpen ? " active" : ""}`}
              onClick={() => setRailTab((current) => (current === "changes" ? null : "changes"))}
              title="Alterações de código propostas pelo agente"
            >
              <span className="agent-panel-history-tab-icon">📝</span>
              <span className="agent-panel-history-tab-label">
                Alterações{reviews.length ? ` (${reviews.length})` : ""}
              </span>
            </button>
            <button
              type="button"
              className={`agent-panel-history-tab${railTab === "chats" ? " active" : ""}`}
              onClick={() => setRailTab((current) => (current === "chats" ? null : "chats"))}
              title="Conversas anteriores neste namespace"
            >
              <span className="agent-panel-history-tab-icon">💬</span>
              <span className="agent-panel-history-tab-label">
                Chats{chatSessions.length ? ` (${chatSessions.length})` : ""}
              </span>
            </button>
          </div>
          <div className={`agent-panel-history-drawer${railTab ? " open" : ""}`}>
            {railTab === "chats" && (
              <>
                <div className="agent-panel-review-header">
                  <h4>Chats anteriores</h4>
                </div>
                <div className="agent-panel-chat-session-list">
                  {chatSessions.length === 0 ? (
                    <p className="connection-status">
                      Nenhum chat arquivado ainda. Clicar em "Novo Chat" guarda a conversa atual
                      aqui antes de começar uma nova.
                    </p>
                  ) : (
                    [...chatSessions].reverse().map((session) => (
                      <div key={session.id} className="agent-panel-chat-session-row">
                        <button
                          type="button"
                          className="agent-panel-chat-session-open"
                          onClick={() => openChatSession(session)}
                          disabled={running}
                          title={session.title}
                        >
                          <span className="agent-panel-chat-session-title">{session.title}</span>
                          <span className="agent-panel-chat-session-date">
                            {new Date(session.updatedAt).toLocaleString()}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="agent-panel-chat-session-delete"
                          onClick={() => removeChatSession(session.id)}
                          title="Excluir este chat do histórico"
                        >
                          🗑
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            {changesOpen && (
              <>
                <div className="agent-panel-review-header">
                  <h4>Alterações{reviews.length ? ` (${reviews.length} rodada(s))` : ""}</h4>
                </div>
                <div
                  className="agent-panel-review-list"
                  ref={reviewListRef}
                  onScroll={handleReviewScroll}
                >
                  {reviews.length === 0 ? (
                    <p className="connection-status">
                      Nenhuma alteração ainda. Execute um prompt.
                    </p>
                  ) : (
                    <div className="agent-review-rows" style={{ height: reviewTotalHeight }}>
                      {visibleReviewRows.map((row, i) => {
                        const top = reviewOffsets[reviewStartIndex + i];
                        if (row.kind === "batch") {
                          return (
                            <div
                              key={row.key}
                              className="agent-review-row-batch"
                              style={{ top, height: BATCH_ROW_HEIGHT }}
                              title={row.prompt}
                            >
                              {row.prompt}
                            </div>
                          );
                        }
                        const isExpanded = expandedEntries.has(row.entryKey);
                        return (
                          <div
                            key={row.key}
                            className="agent-review-row-entry"
                            style={{ top, height: reviewRowHeight(row, expandedEntries) }}
                          >
                            <button
                              type="button"
                              className={`agent-panel-diff-entry-summary agent-panel-diff-entry-${row.entry.status}`}
                              onClick={() => toggleEntryExpanded(row.entryKey)}
                            >
                              <span className="agent-review-row-toggle">
                                {isExpanded ? "▾" : "▸"}
                              </span>
                              <span>
                                {row.entry.status === "approved"
                                  ? "✅ "
                                  : row.entry.status === "failed"
                                    ? "⚠️ "
                                    : "✕ "}
                                {row.entry.name}
                              </span>
                            </button>
                            {isExpanded && (
                              <div
                                className="agent-panel-diff-patch"
                                style={{ height: ENTRY_DIFF_HEIGHT }}
                              >
                                {renderDiffLines(row.entry.patch)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="agent-panel-main">
          <div className="agent-panel-chat" ref={chatRef} onScroll={handleChatScroll}>
            {messages.length === 0 && (
              <p className="connection-status agent-panel-chat-empty">
                O agente responde aqui, no mesmo estilo de um chat. As mensagens ficam salvas ao
                fechar e reabrir esta aba.
              </p>
            )}
            {messages.map((msg) => {
              if (msg.role === "user") {
                return (
                  <div key={msg.id} className="agent-msg agent-msg-user">
                    <div className="agent-msg-avatar">👤</div>
                    <div className="agent-msg-body">
                      <div className="agent-msg-bubble agent-msg-bubble-user">{msg.text}</div>
                    </div>
                  </div>
                );
              }
              return (
                <div key={msg.id} className="agent-msg agent-msg-assistant">
                  <div className="agent-msg-avatar">🤖</div>
                  <div className="agent-msg-body">
                    {msg.reasoning && (
                      // Auto-open while streaming (so it doubles as "proof of life" on a long
                      // prompt) then collapses once the reply is done — still there to expand,
                      // just not competing with the actual answer below it anymore.
                      <details className="agent-msg-reasoning" open={msg.running}>
                        <summary>🧠 Raciocínio</summary>
                        <div className="agent-msg-reasoning-text">{msg.reasoning}</div>
                      </details>
                    )}
                    <div className="agent-msg-tools">
                      {(msg.tools ?? []).map((tool, index) => (
                        <ToolCard key={index} tool={tool} />
                      ))}
                    </div>
                    {msg.text ? (
                      <div className="agent-msg-bubble">
                        <AgentMarkdown text={msg.text} cursor={msg.running} />
                      </div>
                    ) : msg.running ? (
                      <div className="agent-msg-bubble agent-msg-bubble-writing">Escrevendo…</div>
                    ) : null}
                    {msg.error && (
                      <div className="agent-msg-alert">
                        <span className="agent-msg-alert-icon">⚠️</span>
                        <span>{msg.error}</span>
                      </div>
                    )}
                    {/* Right under the message that's actually streaming, Claude-Code-style —
                      follows it up/down the transcript instead of living in a fixed slot below
                      the whole chat, so it's always visually attached to what it's describing. */}
                    {msg.running &&
                      !activeReview &&
                      (stalled ? (
                        <div className="agent-panel-stalled">
                          <span>
                            ⚠ O agente não responde há mais de {Math.round(STALL_MS / 1000)}s,
                            pode estar travado.
                          </span>
                          <button type="button" className="agent-panel-secondary" onClick={abort}>
                            ■ Parar
                          </button>
                        </div>
                      ) : (
                        currentActivity && (
                          <div className="agent-panel-loader">
                            <span className="agent-panel-loader-spinner" />
                            <span>{currentActivity}</span>
                          </div>
                        )
                      ))}
                  </div>
                </div>
              );
            })}
            {liveNotes.map((note, index) => (
              <div
                key={`note-${index}`}
                className={`agent-msg agent-msg-raw${note.stderr ? " agent-msg-error" : ""}`}
              >
                {note.text}
              </div>
            ))}
          </div>

          <div className="agent-panel-composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Peça algo ao opencode sobre este namespace…"
              disabled={running}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void runPrompt();
                }
              }}
            />
            {running ? (
              <button
                type="button"
                className="agent-panel-run-button agent-panel-stop-button"
                onClick={abort}
              >
                ■ Parar
              </button>
            ) : (
              <button
                type="button"
                className="agent-panel-run-button"
                onClick={runPrompt}
                disabled={!prompt.trim()}
              >
                ▶ Executar (Enter)
              </button>
            )}
          </div>
        </div>
      </div>

      {activeReview && (
        <div className="agent-review-dialog-overlay">
          <div className="agent-review-dialog" key={activeReview.pendingId}>
            <div className="agent-review-dialog-header">
              <div className="agent-review-dialog-title">
                <span className="agent-review-dialog-icon">📝</span>
                <div>
                  <h3>{activeReview.name}</h3>
                  <span className="agent-review-dialog-subtitle">
                    Revisão de alteração proposta pelo agente
                  </span>
                </div>
              </div>
              {pendingWrites.length > 1 && (
                <span className="agent-review-dialog-count">1 de {pendingWrites.length}</span>
              )}
            </div>
            <div className="agent-review-dialog-diff">{renderDiffLines(activeReview.patch)}</div>
            <div className="agent-review-dialog-actions">
              <button
                type="button"
                className="agent-panel-secondary"
                onClick={() => resolvePending(activeReview.pendingId, false)}
              >
                ✕ Rejeitar
              </button>
              <button
                type="button"
                className="agent-panel-run-button"
                onClick={() => resolvePending(activeReview.pendingId, true)}
              >
                ✓ Aprovar e salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentPanel;
