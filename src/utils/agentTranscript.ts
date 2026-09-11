/**
 * Parses one line of `opencode run --format json` stdout into something renderable. Shape learned
 * by actually running opencode and inspecting its output (not documented anywhere): each line is
 * `{ type, timestamp, sessionID, part }`, where `part.type` is what actually distinguishes an
 * assistant text chunk from a tool call — e.g. `{"type":"text","part":{"type":"text","text":"Hi"}}`
 * or `{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{...}}}`. Falls back to
 * showing the raw line for anything that doesn't match, since opencode's own JSON format isn't
 * guaranteed to stay exactly like this across versions.
 */
type TranscriptItemBase = {
  /** The event envelope's own `sessionID` — every item carries it (when present) so a caller can
   * tell apart the run's own conversation from a *different* session id showing up on the same
   * stdout stream, which is what a delegated sub-agent ("task" tool) turn looks like: opencode
   * runs it as its own nested session, interleaved into the same `--format json` output. Not
   * verified against a real multi-session run — best-effort based on how session ids are already
   * used elsewhere in this format (see `agent:session`/`--session` in agentRun.ts). */
  sessionId?: string;
};

export type TranscriptItem = TranscriptItemBase &
  (
    // `text` is the FULL cumulative text of this part so far, not just the newest chunk — opencode
    // re-sends the whole running string on every line for a given part id, it doesn't stream deltas.
    // `id` (falling back to a fixed key when opencode omits it) is what lets the caller diff against
    // the last-seen full text for that same part and append only the new suffix.
    | { kind: "text"; id: string; text: string }
    // Model's reasoning/thinking content, streamed when opencode is run with `--thinking` (see
    // agentRun.ts) — mainly useful for long/complex prompts, where otherwise nothing at all shows up
    // on screen while the model is still "silently" working, which is easy to mistake for a hang.
    // Same full-text-per-id caveat as `text` above.
    | { kind: "reasoning"; id: string; text: string }
    | {
        kind: "tool";
        tool: string;
        title?: string;
        status?: string;
        diff?: string;
        input?: unknown;
        /** Set when `status` indicates the tool call itself failed (e.g. a bad `bash` command, a
         * write rejected server-side) — best-effort text pulled from wherever the failure reason
         * turns up in the state blob, since opencode's exact shape for it isn't documented. */
        errorText?: string;
      }
    | { kind: "error"; text: string }
    | { kind: "raw"; text: string }
  );

interface ToolMetadata {
  diff?: string;
  filediff?: { patch?: string };
  error?: unknown;
}

interface ToolState {
  status?: string;
  input?: unknown;
  title?: string;
  metadata?: ToolMetadata;
  output?: unknown;
  error?: unknown;
}

interface AgentPart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
  /** finishReason-style field (Vercel AI SDK convention: "stop" | "tool-calls" | "error" | …) —
   * carried through even though normal step-finish events are dropped, so an "error" reason can
   * still surface instead of silently vanishing along with the rest of that noise. */
  reason?: string;
  error?: unknown;
  message?: string;
}

interface AgentRawEvent {
  type?: string;
  sessionID?: string;
  part?: AgentPart;
  error?: unknown;
  message?: string;
}

const ERROR_STATUSES = new Set(["error", "failed", "failure"]);

// Provider error text for "out of context/tokens" varies a lot (OpenAI-style
// "context_length_exceeded", Anthropic-style "prompt is too long", generic "rate limit"/"quota"
// wording, etc.) and isn't documented for whatever backend opencode is proxying to here — matching
// on keywords instead of one exact shape so the friendlier message below still kicks in even if the
// exact wording differs from whatever this was tested against.
const TOKEN_LIMIT_PATTERN =
  /context.{0,20}(length|window)|too (many|long)|token.{0,10}(limit|exceed)|max(imum)?.{0,10}tokens?|context.{0,10}exceed|rate.?limit|quota|insufficient.?(quota|credit)/i;

/** Prefixes a clearer, translated explanation onto error text that looks like a token/context/quota
 * problem — this is by far the most likely cause of a run silently dying partway through a very
 * large prompt, and "the model returned some cryptic provider error" isn't an actionable message on
 * its own. Leaves the original text untouched (and appended) so nothing is lost for debugging. */
function annotateIfTokenLimit(text: string): string {
  if (!TOKEN_LIMIT_PATTERN.test(text)) return text;
  return (
    `Esta sessão parece ter atingido o limite de tokens/contexto do modelo. Inicie um Novo Chat ` +
    `para continuar. (${text})`
  );
}

/** Digs through a handful of common shapes (`"a string"`, `{message: "..."}`, `{error: "..."}`,
 * `{error: {message: "..."}}`) looking for human-readable error text — opencode's exact envelope
 * for a failure isn't documented, so this takes whatever plausible field is there instead of
 * betting on one exact path and silently coming up empty when it's wrong. */
function extractMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      extractMessage(obj.message, depth + 1) ??
      extractMessage(obj.error, depth + 1) ??
      extractMessage(obj.text, depth + 1)
    );
  }
  return undefined;
}

/** Returns `null` for events that are pure noise (step start/finish markers) and shouldn't take up
 * a line in the transcript at all. */
export function parseAgentLine(line: string): TranscriptItem | null {
  let event: AgentRawEvent;
  try {
    event = JSON.parse(line) as AgentRawEvent;
  } catch {
    return { kind: "raw", text: line };
  }
  const item = parseAgentEvent(event, line);
  if (!item) return null;
  return event.sessionID ? { ...item, sessionId: event.sessionID } : item;
}

function parseAgentEvent(event: AgentRawEvent, line: string): TranscriptItem | null {
  const part = event.part;
  if (!part || typeof part !== "object") {
    // No `part` at all but the envelope itself says "error" — still worth surfacing rather than
    // falling back to an easy-to-miss raw line.
    if (event.type === "error") {
      return {
        kind: "error",
        text: annotateIfTokenLimit(extractMessage(event) ?? "O agente reportou um erro."),
      };
    }
    return { kind: "raw", text: line };
  }

  if (part.type === "text" && typeof part.text === "string") {
    return { kind: "text", id: part.id ?? "text", text: part.text };
  }

  if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
    return { kind: "reasoning", id: part.id ?? "reasoning", text: part.text };
  }

  if (part.type === "tool") {
    const diff = part.state?.metadata?.filediff?.patch ?? part.state?.metadata?.diff;
    const status = part.state?.status;
    const errorText =
      status && ERROR_STATUSES.has(status.toLowerCase())
        ? annotateIfTokenLimit(
            extractMessage(part.state?.metadata?.error) ??
              extractMessage(part.state?.error) ??
              extractMessage(part.state?.output) ??
              "A ferramenta falhou.",
          )
        : undefined;
    return {
      kind: "tool",
      tool: part.tool ?? "tool",
      title: part.state?.title,
      status,
      diff,
      input: part.state?.input,
      errorText,
    };
  }

  if (part.type === "error") {
    return {
      kind: "error",
      text: annotateIfTokenLimit(extractMessage(part) ?? "O agente reportou um erro."),
    };
  }

  if (part.type === "step-start") return null;
  if (part.type === "step-finish") {
    if (part.reason && ERROR_STATUSES.has(part.reason.toLowerCase())) {
      return {
        kind: "error",
        text: annotateIfTokenLimit(extractMessage(part) ?? "A etapa do agente terminou com erro."),
      };
    }
    return null;
  }

  return { kind: "raw", text: line };
}

const TOOL_ICONS: Record<string, string> = {
  read: "🔍",
  grep: "🔍",
  glob: "🔍",
  list: "🔍",
  edit: "✏️",
  write: "✏️",
  patch: "✏️",
  bash: "💻",
  webfetch: "🌐",
  todowrite: "📋",
  todoread: "📋",
  // opencode's own sub-agent delegation tool — kept visually distinct (not the generic 🔧
  // fallback) so a delegated sub-task reads clearly as "handed off to another agent", not just
  // another ordinary tool call.
  task: "🧩",
};

export function toolIcon(tool: string): string {
  return TOOL_ICONS[tool.toLowerCase()] ?? "🔧";
}
