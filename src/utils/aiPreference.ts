// Which AI provider + model the agent should use for the next run. This is a *non-secret*
// preference (like the theme) so it's safe in localStorage — the API key itself is never kept
// here; it lives encrypted in the main process (electron/aiSettings.ts) and is sent straight into
// the `opencode` child's environment at run time (see agentRun.ts).

export interface AiProviderOption {
  id: string;
  label: string;
  /** Example model ids shown in the picker — the real value is a free-form id the user types. */
  models: string[];
}

export const AI_PROVIDERS: AiProviderOption[] = [
  {
    id: "default",
    label: "Padrão do opencode",
    models: [],
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-sonnet-4"],
  },
  {
    id: "google",
    label: "Gemini (Google)",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    models: ["anthropic/claude-3.7-sonnet", "google/gemini-2.5-pro"],
  },
];

export interface AiPreference {
  providerId: string;
  model: string;
}

const STORAGE_KEY = "typer.ai-preference";

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
}
