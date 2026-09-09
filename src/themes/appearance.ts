import type { AppTheme } from "./registry";
import type { VSCodeThemeSetting } from "./convert";

/**
 * VS Code ships its "Dark+"/"Light+" themes as thin overlays that rely on the editor's own
 * built-in per-color defaults for everything they don't explicitly set (most UI colors). Since we
 * don't have that whole default-color-registry, these are the actual VS Code built-in defaults for
 * the specific contributions this app's chrome uses, so those two (and any other sparse theme)
 * still render a fully differentiated UI instead of falling back to one flat color everywhere.
 */
const DARK_DEFAULTS: Record<string, string> = {
  "editor.background": "#1e1e1e",
  "editor.foreground": "#d4d4d4",
  "sideBar.background": "#252526",
  "sideBar.foreground": "#cccccc",
  "tab.activeBackground": "#1e1e1e",
  "tab.inactiveBackground": "#2d2d2d",
  "tab.activeForeground": "#ffffff",
  "tab.inactiveForeground": "#b3b3b3",
  "list.hoverBackground": "#2a2d2e",
  "input.background": "#3c3c3c",
  "input.placeholderForeground": "#a6a6a6",
  "button.background": "#0e639c",
  "button.foreground": "#ffffff",
  "dropdown.background": "#3c3c3c",
  "badge.background": "#4d4d4d",
  "badge.foreground": "#ffffff",
  "titleBar.activeBackground": "#3c3c3c",
  "panel.border": "#2e303a",
  focusBorder: "#007fd4",
};

const LIGHT_DEFAULTS: Record<string, string> = {
  "editor.background": "#ffffff",
  "editor.foreground": "#000000",
  "sideBar.background": "#f3f3f3",
  "sideBar.foreground": "#616161",
  "tab.activeBackground": "#ffffff",
  "tab.inactiveBackground": "#ececec",
  "tab.activeForeground": "#333333",
  "tab.inactiveForeground": "#6f6f6f",
  "list.hoverBackground": "#e8e8e8",
  "input.background": "#ffffff",
  "input.placeholderForeground": "#767676",
  "button.background": "#007acc",
  "button.foreground": "#ffffff",
  "dropdown.background": "#ffffff",
  "badge.background": "#c4c4c4",
  "badge.foreground": "#333333",
  "titleBar.activeBackground": "#dddddd",
  "panel.border": "#e5e4e7",
  focusBorder: "#0090f1",
};

/** Reads the first key present in the theme's own colors, then the first present in the built-in default table for `kind`. */
function pick(
  colors: Record<string, string>,
  kind: "dark" | "light",
  ...keys: string[]
): string | undefined {
  for (const key of keys) if (colors[key]) return colors[key];
  const defaults = kind === "dark" ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  for (const key of keys) if (defaults[key]) return defaults[key];
  return undefined;
}

/**
 * Finds the best (longest/most specific) matching TextMate token-color rule for one of the given
 * scope candidates, in priority order — mirrors Monaco's own longest-prefix rule matching, so the
 * app can reuse the theme's own editor syntax color for a UI element (see the parameter-usage
 * decoration in CodeEditor, which needs the same color the theme already gives `variable.parameter`
 * declarations, without hardcoding a value that would clash with the theme's own palette).
 */
function resolveTokenStyle(
  tokenColors: VSCodeThemeSetting[],
  ...candidates: string[]
): { foreground?: string; fontStyle?: string } | undefined {
  let best: { foreground?: string; fontStyle?: string; specificity: number } | undefined;
  for (const entry of tokenColors) {
    if (!entry.scope) continue;
    const scopes = Array.isArray(entry.scope)
      ? entry.scope
      : entry.scope.split(",").map((s) => s.trim());
    for (const scope of scopes) {
      for (const candidate of candidates) {
        if (scope !== candidate && !candidate.startsWith(`${scope}.`)) continue;
        if (best && scope.length <= best.specificity) continue;
        best = {
          foreground: entry.settings.foreground,
          fontStyle: entry.settings.fontStyle,
          specificity: scope.length,
        };
      }
    }
  }
  return best;
}

/** Maps a VS Code theme's `colors` onto the app shell's own CSS custom properties (see src/style.css).
 * `accentOverride` (from src/utils/accentPreference.ts) lets the user pin the titlebar background and
 * app logo to a color of their choice instead of always following the selected theme's own accent —
 * pass null/undefined to use the theme's accent as before. */
export function applyAppChrome(theme: AppTheme, accentOverride?: string | null) {
  const colors = theme.vscodeTheme.colors;
  const kind = theme.kind;

  const bg = pick(colors, kind, "editor.background")!;
  const fg = pick(colors, kind, "editor.foreground")!;
  const textHeading = pick(
    colors,
    kind,
    "foreground",
    "sideBarTitle.foreground",
    "editor.foreground",
  )!;
  const border = pick(colors, kind, "panel.border", "editorGroup.border")!;
  const accent = pick(colors, kind, "focusBorder", "activityBarBadge.background")!;
  const bgSidebar = pick(colors, kind, "sideBar.background")!;
  const textSidebar = pick(colors, kind, "sideBar.foreground", "foreground", "editor.foreground")!;
  const bgTabActive = pick(colors, kind, "tab.activeBackground", "editor.background")!;
  const bgTabInactive = pick(
    colors,
    kind,
    "tab.inactiveBackground",
    "editorGroupHeader.tabsBackground",
  )!;
  const textTabActive = pick(colors, kind, "tab.activeForeground", "editor.foreground")!;
  const textTabInactive = pick(colors, kind, "tab.inactiveForeground")!;
  const bgHover = pick(colors, kind, "list.hoverBackground")!;
  const bgInput = pick(colors, kind, "input.background")!;
  const textInput = pick(colors, kind, "input.foreground", "editor.foreground")!;
  const borderInput = colors["input.border"] ?? "transparent";
  const textPlaceholder = pick(colors, kind, "input.placeholderForeground")!;
  const bgButton = pick(colors, kind, "button.background")!;
  const textButton = pick(colors, kind, "button.foreground")!;
  // A theme missing this specific key is common (Dracula, Abyss, etc. all leave it unset) — falling
  // back to another theme's literal hover color would clash with this theme's own palette, so derive
  // it from this theme's own button color instead.
  const bgButtonHover =
    colors["button.hoverBackground"] ??
    `color-mix(in srgb, ${bgButton} 85%, ${kind === "dark" ? "white" : "black"} 15%)`;
  const bgDropdown = pick(colors, kind, "dropdown.background", "input.background")!;
  const bgMenu = pick(
    colors,
    kind,
    "menu.background",
    "dropdown.background",
    "sideBar.background",
  )!;
  const textMenu = pick(colors, kind, "menu.foreground", "editor.foreground")!;
  const borderMenu = colors["menu.border"] ?? border;
  const bgBadge = pick(colors, kind, "badge.background")!;
  const textBadge = pick(colors, kind, "badge.foreground")!;
  const colorError =
    pick(colors, kind, "errorForeground", "editorError.foreground") ??
    (kind === "dark" ? "#f87171" : "#dc2626");

  // list.activeSelectionBackground / menu.selectionBackground / scrollbar colors are highly
  // theme-specific with no reliable universal default, so derive them from the theme's own accent
  // and background instead of guessing a fixed hex.
  const bgSelection =
    colors["list.activeSelectionBackground"] ?? `color-mix(in srgb, ${accent} 30%, ${bgSidebar})`;
  const bgMenuSelection = colors["menu.selectionBackground"] ?? bgSelection;
  const bgScrollbar =
    colors["scrollbarSlider.background"] ?? `color-mix(in srgb, ${fg} 25%, transparent)`;
  const bgScrollbarHover =
    colors["scrollbarSlider.hoverBackground"] ?? `color-mix(in srgb, ${fg} 40%, transparent)`;
  const colorSuccess =
    colors["terminal.ansiGreen"] ??
    colors["gitDecoration.addedResourceForeground"] ??
    (kind === "dark" ? "#4ade80" : "#16a34a");

  // Reuse the theme's own editor coloring for method-parameter declarations (via TextMate rules,
  // not the `colors` map) so the parameter-usage decoration matches it exactly instead of picking
  // an unrelated color.
  const paramStyle = resolveTokenStyle(
    theme.vscodeTheme.tokenColors,
    "variable.parameter.objectscript",
    "variable.parameter",
    "variable",
  );
  const colorParameter = paramStyle?.foreground ?? accent;
  const styleParameter = paramStyle?.fontStyle?.includes("italic") ? "italic" : "normal";

  const root = document.documentElement.style;
  root.setProperty("--bg", bg);
  root.setProperty("--text", fg);
  root.setProperty("--text-h", textHeading);
  root.setProperty(
    "--bg-titlebar",
    accentOverride || pick(colors, kind, "titleBar.activeBackground", "sideBar.background")!,
  );
  root.setProperty("--border", border);
  root.setProperty("--accent", accent);

  // The app logo (see AppLogo.tsx) always tracks either the user's chosen accent override or, absent
  // one, this theme's own accent color — so switching themes recolors the logo automatically, and an
  // explicit override recolors it (and the titlebar above) independently of the theme.
  const logoAccent = accentOverride || accent;
  root.setProperty("--logo-color", logoAccent);
  root.setProperty(
    "--logo-color-2",
    `color-mix(in srgb, ${logoAccent} 70%, ${kind === "dark" ? "black" : "white"} 30%)`,
  );

  root.setProperty("--bg-sidebar", bgSidebar);
  root.setProperty("--text-sidebar", textSidebar);
  root.setProperty("--bg-tab-active", bgTabActive);
  root.setProperty("--bg-tab-inactive", bgTabInactive);
  root.setProperty("--text-tab-active", textTabActive);
  root.setProperty("--text-tab-inactive", textTabInactive);
  root.setProperty("--bg-hover", bgHover);
  root.setProperty("--bg-selection", bgSelection);

  root.setProperty("--bg-input", bgInput);
  root.setProperty("--text-input", textInput);
  root.setProperty("--border-input", borderInput);
  root.setProperty("--text-placeholder", textPlaceholder);
  root.setProperty("--bg-dropdown", bgDropdown);

  root.setProperty("--bg-button", bgButton);
  root.setProperty("--text-button", textButton);
  root.setProperty("--bg-button-hover", bgButtonHover);

  root.setProperty("--bg-menu", bgMenu);
  root.setProperty("--text-menu", textMenu);
  root.setProperty("--border-menu", borderMenu);
  root.setProperty("--bg-menu-selection", bgMenuSelection);

  root.setProperty("--bg-badge", bgBadge);
  root.setProperty("--text-badge", textBadge);

  root.setProperty("--bg-scrollbar", bgScrollbar);
  root.setProperty("--bg-scrollbar-hover", bgScrollbarHover);

  root.setProperty("--color-error", colorError);
  root.setProperty("--color-success", colorSuccess);
  root.setProperty("--color-parameter", colorParameter);
  root.setProperty("--style-parameter", styleParameter);

  document.documentElement.setAttribute("data-theme-kind", theme.kind);
}
