import type * as Monaco from "monaco-editor";
import { vscodeThemeToMonaco, type VSCodeTheme } from "./convert";
import darkPlus from "./vscode/dark-plus.json";
import lightPlus from "./vscode/light-plus.json";
import monokai from "./vscode/monokai.json";
import solarizedDark from "./vscode/solarized-dark.json";
import solarizedLight from "./vscode/solarized-light.json";
import abyss from "./vscode/abyss.json";
import kimbieDark from "./vscode/kimbie-dark.json";
import tomorrowNightBlue from "./vscode/tomorrow-night-blue.json";
import dracula from "./vscode/dracula.json";

export interface AppTheme {
  id: string;
  label: string;
  kind: "dark" | "light";
  vscodeTheme: VSCodeTheme;
}

/** Bundled themes ported from VS Code's own (MIT-licensed) built-in themes, see src/themes/vscode/LICENSE.txt. */
export const BUILTIN_THEMES: AppTheme[] = [
  { id: "dark-plus", label: "Dark+ (VS Code)", kind: "dark", vscodeTheme: darkPlus as VSCodeTheme },
  {
    id: "light-plus",
    label: "Light+ (VS Code)",
    kind: "light",
    vscodeTheme: lightPlus as VSCodeTheme,
  },
  { id: "monokai", label: "Monokai", kind: "dark", vscodeTheme: monokai as VSCodeTheme },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    vscodeTheme: solarizedDark as VSCodeTheme,
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    vscodeTheme: solarizedLight as VSCodeTheme,
  },
  { id: "abyss", label: "Abyss", kind: "dark", vscodeTheme: abyss as VSCodeTheme },
  { id: "kimbie-dark", label: "Kimbie Dark", kind: "dark", vscodeTheme: kimbieDark as VSCodeTheme },
  {
    id: "tomorrow-night-blue",
    label: "Tomorrow Night Blue",
    kind: "dark",
    vscodeTheme: tomorrowNightBlue as VSCodeTheme,
  },
  // Ported from the official Dracula theme (MIT-licensed, Dracula Theme), not Microsoft —
  // see src/themes/vscode/dracula-LICENSE.txt.
  { id: "dracula", label: "Dracula", kind: "dark", vscodeTheme: dracula as VSCodeTheme },
];

const customThemes = new Map<string, AppTheme>();
const registeredMonacoIds = new Set<string>();

export function getAllThemes(): AppTheme[] {
  return [...BUILTIN_THEMES, ...customThemes.values()];
}

export function getTheme(id: string): AppTheme | undefined {
  return getAllThemes().find((theme) => theme.id === id);
}

export function applyMonacoTheme(monaco: typeof Monaco, theme: AppTheme) {
  if (registeredMonacoIds.has(theme.id)) return;
  monaco.editor.defineTheme(
    theme.id,
    vscodeThemeToMonaco(theme.vscodeTheme, theme.kind === "dark" ? "vs-dark" : "vs"),
  );
  registeredMonacoIds.add(theme.id);
}

export function registerAllBuiltinThemes(monaco: typeof Monaco) {
  for (const theme of BUILTIN_THEMES) applyMonacoTheme(monaco, theme);
}

/** Registers a theme imported at runtime from a VS Code theme JSON file (see AppTitlebar's "Import theme"). */
export function registerCustomTheme(
  monaco: typeof Monaco,
  id: string,
  label: string,
  kind: "dark" | "light",
  vscodeTheme: VSCodeTheme,
): AppTheme {
  const theme: AppTheme = { id, label, kind, vscodeTheme };
  customThemes.set(id, theme);
  applyMonacoTheme(monaco, theme);
  return theme;
}
