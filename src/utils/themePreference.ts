import type { AppTheme } from "../themes/registry";

const STORAGE_KEY = "typer.theme-preference";

export interface ThemePreference {
  themeId: string;
  /** Only set when themeId is a custom (imported) theme — built-in themes are already bundled with
   * the app, but a custom one otherwise only lives in memory (see registry.ts's `customThemes` Map)
   * and would be gone on next launch without its full definition saved here too. */
  custom?: Pick<AppTheme, "id" | "label" | "kind" | "vscodeTheme">;
}

/** Reads the last-selected theme, if any was ever saved (or if storage is unavailable/corrupted). */
export function loadThemePreference(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThemePreference>;
    return typeof parsed.themeId === "string" ? (parsed as ThemePreference) : null;
  } catch {
    return null;
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Storage full or unavailable (e.g. private/incognito-like context) — losing the saved theme
    // choice isn't worth surfacing to the user over.
  }
}
