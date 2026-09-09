// Optional override for the titlebar/logo accent color, independent of the syntax theme (see
// themePreference.ts for the theme itself). Mirrors its localStorage pattern — absent means "derive
// the accent from the current theme", same as before this preference existed.
const STORAGE_KEY = "typer.accent-preference";

export function loadAccentOverride(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveAccentOverride(color: string | null): void {
  try {
    if (color) localStorage.setItem(STORAGE_KEY, color);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full/unavailable — losing the override just means it falls back to the theme's own accent.
  }
}
