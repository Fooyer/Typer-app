// Which AI provider + model the agent should use for the next run. This is a *non-secret*
// preference (like the theme) so it's safe in localStorage — the API key itself is never kept
// here; it lives encrypted in the main process (electron/aiSettings.ts) and is sent straight into
// the `opencode` child's environment at run time (see agentRun.ts).

export interface AiProviderOption {
  id: string;
  label: string;
}

export const AI_PROVIDERS: AiProviderOption[] = [
  {
    id: "default",
    label: "Padrão do opencode",
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
  },
  {
    id: "google",
    label: "Gemini (Google)",
  },
  {
    id: "openai",
    label: "OpenAI",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
  },
];

export interface AiPreference {
  providerId: string;
  model: string;
}

const STORAGE_KEY = "typer.ai-preference";
// Fired on the same window whenever the preference is saved — plain `storage` events only reach
// *other* tabs/windows, never the one that called `localStorage.setItem`, so an already-mounted
// AgentPanel (which reads this once at mount) would otherwise keep running the stale
// provider/model until the app restarts even after Settings is saved.
const CHANGE_EVENT = "typer:ai-preference-changed";

function defaultPreference(): AiPreference {
  return { providerId: "default", model: "" };
}

export function loadAiPreference(): AiPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPreference();
    const parsed = JSON.parse(raw) as Partial<AiPreference>;
    return {
      providerId: typeof parsed.providerId === "string" ? parsed.providerId : "default",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return defaultPreference();
  }
}

export function saveAiPreference(preference: AiPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Storage full or unavailable — losing the model choice isn't worth surfacing to the user.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: preference }));
}

/** Subscribes to `saveAiPreference` calls made anywhere in this window (e.g. Settings) so an
 * already-mounted consumer (AgentPanel) can refresh instead of running with whatever preference
 * was current when it first mounted. Returns an unsubscribe function. */
export function onAiPreferenceChange(listener: (preference: AiPreference) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<AiPreference>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
